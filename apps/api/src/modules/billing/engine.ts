import { Prisma } from '@prisma/client';

/**
 * The billing engine: one pure function that turns order lines into GST-correct amounts.
 * Everything that shows money (order totals, invoices, credit notes) goes through here, so the
 * POS can never disagree with the bill. All arithmetic is decimal; amounts are rounded to paise
 * with ROUND_HALF_UP at well-defined points, and the totals are sums of the rounded lines.
 *
 * Rules (documented in docs/billing.md):
 *  - lineSubtotal = (unitPrice + modifiers per unit) × quantity, as entered on the menu. On an
 *    INCLUSIVE branch that figure already contains GST; on EXCLUSIVE it does not.
 *  - Item discounts come off their line; order discounts are applied in order to what remains and
 *    spread over lines in proportion to it (largest remainder, so the paise add up exactly).
 *  - Taxable value: EXCLUSIVE → net amount; INCLUSIVE → net × 100 / (100 + rate).
 *  - Intra-state: CGST = SGST = taxable × rate/2 (exclusive), or tax split in half with the odd
 *    paisa on SGST (inclusive). Inter-state: IGST = the whole tax.
 *  - Service charge is a percentage of the taxable value and attracts GST at the rate of the
 *    items it is charged on (one service-charge line per rate).
 *  - grandTotal = taxableAmount + taxTotal + roundOff, where roundOff brings the total to the
 *    nearest rupee (or 0 for NEAREST_PAISA).
 */

export type D = Prisma.Decimal;
const Dec = Prisma.Decimal;
const ZERO = new Dec(0);
const HUNDRED = new Dec(100);

export const money = (v: Prisma.Decimal.Value): D => new Dec(v).toDecimalPlaces(2, Dec.ROUND_HALF_UP);

export type DiscountKind = 'PERCENTAGE' | 'FIXED';
export interface DiscountInput {
  type: DiscountKind;
  value: Prisma.Decimal.Value;
}

export interface EngineLine {
  key: string;
  unitPrice: Prisma.Decimal.Value;
  modifiersPerUnit: Prisma.Decimal.Value;
  quantity: Prisma.Decimal.Value;
  taxRate: Prisma.Decimal.Value;
  priceIncludesTax: boolean;
  discounts?: DiscountInput[];
}

export interface EngineInput {
  lines: EngineLine[];
  orderDiscounts?: DiscountInput[];
  supplyType: 'INTRA_STATE' | 'INTER_STATE';
  serviceChargePercent?: Prisma.Decimal.Value;
  roundingMode: 'NEAREST_RUPEE' | 'NEAREST_PAISA';
}

export interface TaxSplit {
  taxableAmount: D;
  cgstAmount: D;
  sgstAmount: D;
  igstAmount: D;
  taxAmount: D;
}

export interface LineResult extends TaxSplit {
  key: string;
  lineSubtotal: D;
  modifiersTotal: D;
  itemDiscount: D;
  /** Item discounts first, each with its computed amount, in the order given. */
  itemDiscountAmounts: D[];
  orderDiscountShare: D;
  discountAmount: D;
  lineTotal: D;
}

export interface ServiceChargeLine extends TaxSplit {
  taxRate: D;
  lineTotal: D;
}

export interface EngineResult {
  lines: LineResult[];
  serviceCharges: ServiceChargeLine[];
  orderDiscountAmounts: D[];
  subtotal: D;
  discountTotal: D;
  serviceCharge: D;
  taxableAmount: D;
  cgstAmount: D;
  sgstAmount: D;
  igstAmount: D;
  taxTotal: D;
  roundOff: D;
  grandTotal: D;
}

/** Amount of one discount on a base (never more than the base, never negative). */
export function discountAmount(d: DiscountInput, base: D): D {
  if (base.lte(0)) return ZERO;
  const value = new Dec(d.value);
  if (value.lte(0)) throw new RangeError('Discount value must be positive');
  if (d.type === 'PERCENTAGE') {
    if (value.gt(100)) throw new RangeError('Percentage discount cannot exceed 100');
    return Dec.min(money(base.mul(value).div(HUNDRED)), base);
  }
  return Dec.min(money(value), base);
}

/** Splits `amount` over `weights` proportionally in paise, so the parts sum to exactly `amount`. */
export function allocate(amount: D, weights: D[]): D[] {
  const total = weights.reduce((a, w) => a.add(w), ZERO);
  if (amount.isZero() || total.lte(0)) return weights.map(() => ZERO);
  const paise = amount.mul(100).toNumber();
  const raw = weights.map((w) => w.mul(paise).div(total));
  const floors = raw.map((r) => r.floor());
  let remainder = paise - floors.reduce((a, f) => a + f.toNumber(), 0);
  const order = raw
    .map((r, i) => ({ i, frac: r.sub(r.floor()).toNumber() }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const out = floors.map((f) => f);
  for (const { i } of order) {
    if (remainder <= 0) break;
    out[i] = out[i].add(1);
    remainder--;
  }
  return out.map((p) => p.div(100));
}

/** GST on a net amount at `rate`%. */
export function taxOn(net: D, rate: D, inclusive: boolean, supplyType: EngineInput['supplyType']): TaxSplit {
  if (rate.isZero() || net.isZero()) {
    return { taxableAmount: money(net), cgstAmount: ZERO, sgstAmount: ZERO, igstAmount: ZERO, taxAmount: ZERO };
  }
  if (inclusive) {
    const taxableAmount = money(net.mul(HUNDRED).div(HUNDRED.add(rate)));
    const taxAmount = money(net).sub(taxableAmount);
    if (supplyType === 'INTER_STATE') return { taxableAmount, cgstAmount: ZERO, sgstAmount: ZERO, igstAmount: taxAmount, taxAmount };
    const cgstAmount = money(taxAmount.div(2).toDecimalPlaces(2, Dec.ROUND_DOWN));
    return { taxableAmount, cgstAmount, sgstAmount: taxAmount.sub(cgstAmount), igstAmount: ZERO, taxAmount };
  }
  const taxableAmount = money(net);
  if (supplyType === 'INTER_STATE') {
    const igstAmount = money(taxableAmount.mul(rate).div(HUNDRED));
    return { taxableAmount, cgstAmount: ZERO, sgstAmount: ZERO, igstAmount, taxAmount: igstAmount };
  }
  const half = money(taxableAmount.mul(rate).div(200));
  return { taxableAmount, cgstAmount: half, sgstAmount: half, igstAmount: ZERO, taxAmount: half.add(half) };
}

export function computeBill(input: EngineInput): EngineResult {
  // 1. Gross and item discounts.
  const stage = input.lines.map((l) => {
    const qty = new Dec(l.quantity);
    if (qty.lte(0)) throw new RangeError('Quantity must be positive');
    const modifiersTotal = money(new Dec(l.modifiersPerUnit).mul(qty));
    const lineSubtotal = money(new Dec(l.unitPrice).mul(qty)).add(modifiersTotal);
    let remaining = lineSubtotal;
    const itemDiscountAmounts: D[] = [];
    for (const d of l.discounts ?? []) {
      const amt = discountAmount(d, remaining);
      itemDiscountAmounts.push(amt);
      remaining = remaining.sub(amt);
    }
    return { l, modifiersTotal, lineSubtotal, itemDiscountAmounts, itemDiscount: lineSubtotal.sub(remaining), afterItem: remaining };
  });

  // 2. Order discounts, applied in sequence and spread over the lines.
  const orderDiscountAmounts: D[] = [];
  const shares = stage.map(() => ZERO);
  let bases = stage.map((s) => s.afterItem);
  for (const d of input.orderDiscounts ?? []) {
    const base = bases.reduce((a, b) => a.add(b), ZERO);
    const amt = discountAmount(d, base);
    orderDiscountAmounts.push(amt);
    const parts = allocate(amt, bases);
    parts.forEach((p, i) => (shares[i] = shares[i].add(p)));
    bases = bases.map((b, i) => b.sub(parts[i]));
  }

  // 3. Tax per line.
  const lines: LineResult[] = stage.map((s, i) => {
    const net = bases[i];
    const tax = taxOn(net, new Dec(s.l.taxRate), s.l.priceIncludesTax, input.supplyType);
    return {
      key: s.l.key,
      lineSubtotal: s.lineSubtotal,
      modifiersTotal: s.modifiersTotal,
      itemDiscount: s.itemDiscount,
      itemDiscountAmounts: s.itemDiscountAmounts,
      orderDiscountShare: shares[i],
      discountAmount: s.itemDiscount.add(shares[i]),
      ...tax,
      lineTotal: tax.taxableAmount.add(tax.taxAmount),
    };
  });

  // 4. Service charge per tax rate.
  const scPct = new Dec(input.serviceChargePercent ?? 0);
  const serviceCharges: ServiceChargeLine[] = [];
  if (scPct.gt(0)) {
    const byRate = new Map<string, D>();
    lines.forEach((ln, i) => {
      const k = new Dec(input.lines[i].taxRate).toString();
      byRate.set(k, (byRate.get(k) ?? ZERO).add(ln.taxableAmount));
    });
    for (const [rate, taxable] of [...byRate].sort((a, b) => new Dec(a[0]).cmp(new Dec(b[0])))) {
      const scNet = money(taxable.mul(scPct).div(HUNDRED));
      if (scNet.isZero()) continue;
      const tax = taxOn(scNet, new Dec(rate), false, input.supplyType);
      serviceCharges.push({ taxRate: new Dec(rate), ...tax, lineTotal: tax.taxableAmount.add(tax.taxAmount) });
    }
  }

  // 5. Totals.
  const sum = (xs: D[]) => xs.reduce((a, b) => a.add(b), ZERO);
  const all: TaxSplit[] = [...lines, ...serviceCharges];
  const taxableAmount = sum(all.map((x) => x.taxableAmount));
  const cgstAmount = sum(all.map((x) => x.cgstAmount));
  const sgstAmount = sum(all.map((x) => x.sgstAmount));
  const igstAmount = sum(all.map((x) => x.igstAmount));
  const taxTotal = cgstAmount.add(sgstAmount).add(igstAmount);
  const raw = taxableAmount.add(taxTotal);
  const grandTotal = input.roundingMode === 'NEAREST_RUPEE' ? raw.toDecimalPlaces(0, Dec.ROUND_HALF_UP) : raw;

  return {
    lines,
    serviceCharges,
    orderDiscountAmounts,
    subtotal: sum(lines.map((l) => l.lineSubtotal)),
    discountTotal: sum(lines.map((l) => l.discountAmount)),
    serviceCharge: sum(serviceCharges.map((s) => s.taxableAmount)),
    taxableAmount,
    cgstAmount,
    sgstAmount,
    igstAmount,
    taxTotal,
    roundOff: grandTotal.sub(raw),
    grandTotal,
  };
}
