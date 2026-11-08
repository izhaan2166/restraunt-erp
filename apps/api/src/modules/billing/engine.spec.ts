import { Prisma } from '@prisma/client';
import { allocate, computeBill, discountAmount, EngineLine, taxOn } from './engine';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const s = (d: Prisma.Decimal) => d.toFixed(2);
const line = (key: string, unitPrice: string, quantity: string, extra: Partial<EngineLine> = {}): EngineLine => ({
  key,
  unitPrice,
  quantity,
  modifiersPerUnit: '0',
  taxRate: '5',
  priceIncludesTax: false,
  ...extra,
});

describe('billing engine', () => {
  it('exclusive 5% GST: CGST and SGST are 2.5% each of the taxable value', () => {
    const r = computeBill({ lines: [line('a', '280.00', '2')], supplyType: 'INTRA_STATE', roundingMode: 'NEAREST_RUPEE' });
    expect([s(r.subtotal), s(r.taxableAmount), s(r.cgstAmount), s(r.sgstAmount), s(r.igstAmount), s(r.grandTotal)]).toEqual([
      '560.00', '560.00', '14.00', '14.00', '0.00', '588.00',
    ]);
    expect(s(r.roundOff)).toBe('0.00');
  });

  it('inclusive 5% GST: taxable value is backed out of the menu price', () => {
    expect(taxOn(D('105'), D('5'), true, 'INTRA_STATE')).toEqual(
      expect.objectContaining({ taxableAmount: D('100'), cgstAmount: D('2.5'), sgstAmount: D('2.5'), taxAmount: D('5') }),
    );
    // 99 × 100/105 = 94.2857… → 94.29; tax 4.71 split 2.35 + 2.36 (the odd paisa on SGST).
    const t = taxOn(D('99'), D('5'), true, 'INTRA_STATE');
    expect([s(t.taxableAmount), s(t.cgstAmount), s(t.sgstAmount), s(t.taxAmount)]).toEqual(['94.29', '2.35', '2.36', '4.71']);
    const r = computeBill({ lines: [line('a', '99', '1', { priceIncludesTax: true })], supplyType: 'INTRA_STATE', roundingMode: 'NEAREST_PAISA' });
    expect(s(r.grandTotal)).toBe('99.00'); // the customer pays the menu price
  });

  it('inter-state supplies carry IGST only', () => {
    const r = computeBill({ lines: [line('a', '1000', '1', { taxRate: '18' })], supplyType: 'INTER_STATE', roundingMode: 'NEAREST_PAISA' });
    expect([s(r.cgstAmount), s(r.sgstAmount), s(r.igstAmount), s(r.grandTotal)]).toEqual(['0.00', '0.00', '180.00', '1180.00']);
  });

  it('modifiers are priced per unit and multiplied by quantity', () => {
    const r = computeBill({ lines: [line('a', '200', '2', { modifiersPerUnit: '40' })], supplyType: 'INTRA_STATE', roundingMode: 'NEAREST_PAISA' });
    expect(s(r.lines[0].lineSubtotal)).toBe('480.00');
    expect(s(r.lines[0].modifiersTotal)).toBe('80.00');
  });

  it('order discounts are spread over lines; totals round to the rupee', () => {
    const r = computeBill({
      lines: [line('a', '100', '1'), line('b', '50', '1')],
      orderDiscounts: [{ type: 'PERCENTAGE', value: '10' }],
      supplyType: 'INTRA_STATE',
      roundingMode: 'NEAREST_RUPEE',
    });
    expect(r.lines.map((l) => s(l.orderDiscountShare))).toEqual(['10.00', '5.00']);
    // 90 → 2.25 + 2.25; 45 → 1.13 + 1.13 (2.25 × 0.5 rounded half-up per component)
    expect(r.lines.map((l) => s(l.taxAmount))).toEqual(['4.50', '2.26']);
    expect([s(r.discountTotal), s(r.taxableAmount), s(r.taxTotal), s(r.roundOff), s(r.grandTotal)]).toEqual([
      '15.00', '135.00', '6.76', '0.24', '142.00',
    ]);
  });

  it('item discounts come off their own line before order discounts', () => {
    const r = computeBill({
      lines: [line('a', '200', '1', { discounts: [{ type: 'FIXED', value: '50' }] }), line('b', '100', '1')],
      orderDiscounts: [{ type: 'FIXED', value: '25' }],
      supplyType: 'INTRA_STATE',
      roundingMode: 'NEAREST_PAISA',
    });
    // Remaining bases 150 and 100 → order discount 25 split 15 / 10.
    expect(r.lines.map((l) => [s(l.itemDiscount), s(l.orderDiscountShare), s(l.taxableAmount)])).toEqual([
      ['50.00', '15.00', '135.00'],
      ['0.00', '10.00', '90.00'],
    ]);
    expect(r.orderDiscountAmounts.map(s)).toEqual(['25.00']);
  });

  it('a discount never exceeds what it applies to', () => {
    expect(s(discountAmount({ type: 'FIXED', value: '500' }, D('120')))).toBe('120.00');
    expect(s(discountAmount({ type: 'PERCENTAGE', value: '100' }, D('120')))).toBe('120.00');
    expect(() => discountAmount({ type: 'PERCENTAGE', value: '101' }, D('1'))).toThrow(RangeError);
    const r = computeBill({ lines: [line('a', '100', '1')], orderDiscounts: [{ type: 'FIXED', value: '1000' }], supplyType: 'INTRA_STATE', roundingMode: 'NEAREST_RUPEE' });
    expect(s(r.grandTotal)).toBe('0.00');
  });

  it('service charge is taxed at the rate of the items it is charged on', () => {
    const r = computeBill({
      lines: [line('a', '100', '1'), line('b', '200', '1', { taxRate: '18' })],
      serviceChargePercent: '10',
      supplyType: 'INTRA_STATE',
      roundingMode: 'NEAREST_PAISA',
    });
    expect(r.serviceCharges.map((x) => [s(x.taxRate), s(x.taxableAmount), s(x.taxAmount)])).toEqual([
      ['5.00', '10.00', '0.50'],
      ['18.00', '20.00', '3.60'],
    ]);
    expect(s(r.serviceCharge)).toBe('30.00');
    // 300 + 30 taxable; tax 5 + 36 + 0.5 + 3.6
    expect([s(r.taxableAmount), s(r.taxTotal), s(r.grandTotal)]).toEqual(['330.00', '45.10', '375.10']);
  });

  it('allocation always sums to the amount exactly', () => {
    expect(allocate(D('100'), [D(1), D(1), D(1)]).map(s)).toEqual(['33.34', '33.33', '33.33']);
    expect(allocate(D('0.01'), [D(5), D(5)]).map(s)).toEqual(['0.01', '0.00']);
    expect(allocate(D('10'), [D(0), D(0)]).map(s)).toEqual(['0.00', '0.00']);
  });

  it('invariants hold over many random bills', () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let n = 0; n < 500; n++) {
      const lines = Array.from({ length: 1 + Math.floor(rnd() * 6) }, (_, i) =>
        line(`l${i}`, (rnd() * 900 + 1).toFixed(2), String(1 + Math.floor(rnd() * 4)), {
          taxRate: ['0', '5', '12', '18'][Math.floor(rnd() * 4)],
          priceIncludesTax: rnd() < 0.5,
          modifiersPerUnit: rnd() < 0.3 ? (rnd() * 50).toFixed(2) : '0',
          discounts: rnd() < 0.3 ? [{ type: 'PERCENTAGE', value: (rnd() * 30 + 1).toFixed(2) }] : [],
        }),
      );
      const r = computeBill({
        lines,
        orderDiscounts: rnd() < 0.4 ? [{ type: rnd() < 0.5 ? 'FIXED' : 'PERCENTAGE', value: (rnd() * 20 + 1).toFixed(2) }] : [],
        serviceChargePercent: rnd() < 0.3 ? '10' : '0',
        supplyType: rnd() < 0.2 ? 'INTER_STATE' : 'INTRA_STATE',
        roundingMode: rnd() < 0.7 ? 'NEAREST_RUPEE' : 'NEAREST_PAISA',
      });
      expect(r.grandTotal.eq(r.taxableAmount.add(r.taxTotal).add(r.roundOff))).toBe(true);
      expect(r.taxTotal.eq(r.cgstAmount.add(r.sgstAmount).add(r.igstAmount))).toBe(true);
      expect(r.discountTotal.lte(r.subtotal)).toBe(true);
      expect(r.roundOff.abs().lte(0.5)).toBe(true);
      for (const l of r.lines) {
        expect(l.lineTotal.eq(l.taxableAmount.add(l.taxAmount))).toBe(true);
        expect(l.taxableAmount.gte(0) && l.taxAmount.gte(0)).toBe(true);
        expect(l.discountAmount.lte(l.lineSubtotal)).toBe(true);
        expect(l.taxableAmount.decimalPlaces()).toBeLessThanOrEqual(2);
      }
      const inclusiveOnly = lines.every((l) => l.priceIncludesTax) && r.serviceCharge.isZero();
      if (inclusiveOnly) {
        // With tax-inclusive prices the bill (before rounding) equals the discounted menu prices.
        expect(r.taxableAmount.add(r.taxTotal).eq(r.subtotal.sub(r.discountTotal))).toBe(true);
      }
    }
  });
});
