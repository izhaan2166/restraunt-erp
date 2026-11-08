import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { D, ZERO, dec } from './report';
import type { Period } from './scope';

/**
 * The financial building blocks every sales figure is made from, one SQL aggregate each, grouped
 * by branch and (optionally) by an India-time period bucket. Definitions (docs/reports.md):
 *
 *  - Sales are counted on the invoice date. Finalized and cancelled invoices both count, because
 *    cancelling issues a credit note for what was left; credit notes count on their own date.
 *  - grossSales   = Σ invoice subtotal (menu value of the items before discounts; on a GST-inclusive
 *                   branch this figure contains GST)
 *  - netSales     = Σ taxable value − Σ credit note taxable value (excludes GST; includes service charge)
 *  - netTax       = Σ GST − Σ credit note GST
 *  - netBilled    = Σ grand total − Σ credit note total (what customers were charged, GST included)
 *  - collected    = Σ completed payments (on the payment date); refunded = Σ completed refunds
 *  - netCollected = collected − refunded
 */
export type Unit = 'day' | 'week' | 'month' | 'year' | null;

export interface Fact {
  invoices: number;
  cancelledInvoices: number;
  gross: D;
  discounts: D;
  serviceCharge: D;
  taxable: D;
  cgst: D;
  sgst: D;
  igst: D;
  tax: D;
  roundOff: D;
  billed: D;
  /** Grand totals of invoices that are still final (for the average bill). */
  finalBilled: D;
  creditNotes: number;
  cnTaxable: D;
  cnCgst: D;
  cnSgst: D;
  cnIgst: D;
  cnTax: D;
  cnTotal: D;
  payments: number;
  collected: D;
  refunds: number;
  refunded: D;
}

export const emptyFact = (): Fact => ({
  invoices: 0,
  cancelledInvoices: 0,
  gross: ZERO,
  discounts: ZERO,
  serviceCharge: ZERO,
  taxable: ZERO,
  cgst: ZERO,
  sgst: ZERO,
  igst: ZERO,
  tax: ZERO,
  roundOff: ZERO,
  billed: ZERO,
  finalBilled: ZERO,
  creditNotes: 0,
  cnTaxable: ZERO,
  cnCgst: ZERO,
  cnSgst: ZERO,
  cnIgst: ZERO,
  cnTax: ZERO,
  cnTotal: ZERO,
  payments: 0,
  collected: ZERO,
  refunds: 0,
  refunded: ZERO,
});

export function addFacts(a: Fact, b: Fact): Fact {
  const out = { ...a };
  for (const k of Object.keys(b) as (keyof Fact)[]) {
    const x = a[k];
    const y = b[k];
    (out as Record<string, unknown>)[k] = typeof x === 'number' ? x + (y as number) : (x as D).add(y as D);
  }
  return out;
}

export const derived = (f: Fact) => ({
  netSales: f.taxable.sub(f.cnTaxable),
  netTax: f.tax.sub(f.cnTax),
  netBilled: f.billed.sub(f.cnTotal),
  netCollected: f.collected.sub(f.refunded),
});

/** The bucket of a timestamp column in India time, as 'YYYY-MM-DD' (start of the period), or NULL. */
const bucket = (col: string, unit: Unit) => Prisma.sql`to_char(date_trunc(${unit}::text, ${Prisma.raw(col)} AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD')`;

type Raw = Record<string, unknown> & { branch_id: string; bucket: string | null };

/** Sales facts keyed by `${branchId}|${bucket ?? ''}`. */
export async function salesFacts(prisma: PrismaService, org: string, branchIds: string[], p: Period, unit: Unit = null): Promise<Map<string, Fact>> {
  const [inv, cn, pay, ref] = await Promise.all([
    prisma.$queryRaw<Raw[]>`
      SELECT i.branch_id::text AS branch_id, ${bucket('i.invoice_date', unit)} AS bucket,
        count(*) FILTER (WHERE i.status = 'FINALIZED')::int AS invoices,
        count(*) FILTER (WHERE i.status = 'CANCELLED')::int AS cancelled,
        sum(i.subtotal) AS gross, sum(i.discount_total) AS discounts, sum(i.service_charge) AS service_charge,
        sum(i.taxable_amount) AS taxable, sum(i.cgst_amount) AS cgst, sum(i.sgst_amount) AS sgst, sum(i.igst_amount) AS igst,
        sum(i.tax_total) AS tax, sum(i.round_off) AS round_off, sum(i.grand_total) AS billed,
        coalesce(sum(i.grand_total) FILTER (WHERE i.status = 'FINALIZED'), 0) AS final_billed
      FROM invoices i
      WHERE i.organization_id = ${org}::uuid AND i.branch_id = ANY(${branchIds}::uuid[]) AND i.status IN ('FINALIZED', 'CANCELLED')
        AND i.invoice_date >= ${p.gte} AND i.invoice_date < ${p.lt}
      GROUP BY 1, 2`,
    prisma.$queryRaw<Raw[]>`
      SELECT c.branch_id::text AS branch_id, ${bucket('c.created_at', unit)} AS bucket, count(*)::int AS n,
        sum(c.taxable_amount) AS taxable, sum(c.cgst_amount) AS cgst, sum(c.sgst_amount) AS sgst, sum(c.igst_amount) AS igst,
        sum(c.cgst_amount + c.sgst_amount + c.igst_amount) AS tax, sum(c.total_amount) AS total
      FROM credit_notes c
      WHERE c.organization_id = ${org}::uuid AND c.branch_id = ANY(${branchIds}::uuid[]) AND c.created_at >= ${p.gte} AND c.created_at < ${p.lt}
      GROUP BY 1, 2`,
    prisma.$queryRaw<Raw[]>`
      SELECT y.branch_id::text AS branch_id, ${bucket('y.received_at', unit)} AS bucket, count(*)::int AS n, sum(y.amount) AS amount
      FROM payments y
      WHERE y.organization_id = ${org}::uuid AND y.branch_id = ANY(${branchIds}::uuid[]) AND y.status = 'COMPLETED'
        AND y.received_at >= ${p.gte} AND y.received_at < ${p.lt}
      GROUP BY 1, 2`,
    prisma.$queryRaw<Raw[]>`
      SELECT r.branch_id::text AS branch_id, ${bucket('r.created_at', unit)} AS bucket, count(*)::int AS n, sum(r.amount) AS amount
      FROM refunds r
      WHERE r.organization_id = ${org}::uuid AND r.branch_id = ANY(${branchIds}::uuid[]) AND r.status = 'COMPLETED'
        AND r.created_at >= ${p.gte} AND r.created_at < ${p.lt}
      GROUP BY 1, 2`,
  ]);
  const out = new Map<string, Fact>();
  const at = (r: Raw) => {
    const k = `${r.branch_id}|${r.bucket ?? ''}`;
    const f = out.get(k) ?? emptyFact();
    out.set(k, f);
    return f;
  };
  for (const r of inv) {
    Object.assign(at(r), {
      invoices: Number(r.invoices),
      cancelledInvoices: Number(r.cancelled),
      gross: dec(r.gross),
      discounts: dec(r.discounts),
      serviceCharge: dec(r.service_charge),
      taxable: dec(r.taxable),
      cgst: dec(r.cgst),
      sgst: dec(r.sgst),
      igst: dec(r.igst),
      tax: dec(r.tax),
      roundOff: dec(r.round_off),
      billed: dec(r.billed),
      finalBilled: dec(r.final_billed),
    });
  }
  for (const r of cn) Object.assign(at(r), { creditNotes: Number(r.n), cnTaxable: dec(r.taxable), cnCgst: dec(r.cgst), cnSgst: dec(r.sgst), cnIgst: dec(r.igst), cnTax: dec(r.tax), cnTotal: dec(r.total) });
  for (const r of pay) Object.assign(at(r), { payments: Number(r.n), collected: dec(r.amount) });
  for (const r of ref) Object.assign(at(r), { refunds: Number(r.n), refunded: dec(r.amount) });
  return out;
}

/** Sums the facts of each branch (ignoring buckets) or of each bucket (ignoring branches). */
export function rollUp(facts: Map<string, Fact>, by: 'branch' | 'bucket'): Map<string, Fact> {
  const out = new Map<string, Fact>();
  for (const [k, f] of facts) {
    const [branch, b] = k.split('|');
    const key = by === 'branch' ? branch : b;
    out.set(key, addFacts(out.get(key) ?? emptyFact(), f));
  }
  return out;
}

export const total = (facts: Map<string, Fact>) => [...facts.values()].reduce(addFacts, emptyFact());

export interface OrderCounts {
  total: number;
  completed: number;
  cancelled: number;
  pending: number;
}

/** Orders created in the period, per branch, by where they stand now. */
export async function orderCounts(prisma: PrismaService, org: string, branchIds: string[], p: Period): Promise<Map<string, OrderCounts>> {
  const rows = await prisma.$queryRaw<{ branch_id: string; total: number; completed: number; cancelled: number }[]>`
    SELECT o.branch_id::text AS branch_id, count(*)::int AS total,
      count(*) FILTER (WHERE o.status = 'COMPLETED')::int AS completed,
      count(*) FILTER (WHERE o.status = 'CANCELLED')::int AS cancelled
    FROM orders o
    WHERE o.organization_id = ${org}::uuid AND o.branch_id = ANY(${branchIds}::uuid[]) AND o.created_at >= ${p.gte} AND o.created_at < ${p.lt}
    GROUP BY 1`;
  return new Map(rows.map((r) => [r.branch_id, { total: r.total, completed: r.completed, cancelled: r.cancelled, pending: r.total - r.completed - r.cancelled }]));
}

export interface CostFacts {
  /** Recipe cost of what was sold (consumption minus reversals), at the average cost at the time. */
  cogs: D;
  wastage: D;
  expenses: D;
  expenseTax: D;
  expenseCount: number;
}

/** Cost side of the profit estimate, per branch. */
export async function costFacts(prisma: PrismaService, org: string, branchIds: string[], p: Period): Promise<Map<string, CostFacts>> {
  const [stock, exp] = await Promise.all([
    prisma.$queryRaw<{ branch_id: string; cogs: unknown; wastage: unknown }[]>`
      SELECT m.branch_id::text AS branch_id,
        coalesce(sum(round(abs(m.quantity) * coalesce(m.unit_cost, 0), 2)) FILTER (WHERE m.type = 'SALE_CONSUMPTION'), 0)
          - coalesce(sum(round(abs(m.quantity) * coalesce(m.unit_cost, 0), 2)) FILTER (WHERE m.type = 'SALE_REVERSAL'), 0) AS cogs,
        coalesce(sum(round(abs(m.quantity) * coalesce(m.unit_cost, 0), 2)) FILTER (WHERE m.type = 'WASTAGE'), 0) AS wastage
      FROM stock_movements m
      WHERE m.organization_id = ${org}::uuid AND m.branch_id = ANY(${branchIds}::uuid[]) AND m.created_at >= ${p.gte} AND m.created_at < ${p.lt}
      GROUP BY 1`,
    prisma.$queryRaw<{ branch_id: string; amount: unknown; tax: unknown; n: number }[]>`
      SELECT e.branch_id::text AS branch_id, sum(e.amount) AS amount, sum(e.tax_amount) AS tax, count(*)::int AS n
      FROM expenses e
      WHERE e.organization_id = ${org}::uuid AND e.branch_id = ANY(${branchIds}::uuid[]) AND e.deleted_at IS NULL
        AND e.expense_date >= ${p.from}::date AND e.expense_date <= ${p.to}::date
      GROUP BY 1`,
  ]);
  const out = new Map<string, CostFacts>();
  const at = (b: string) => out.get(b) ?? { cogs: ZERO, wastage: ZERO, expenses: ZERO, expenseTax: ZERO, expenseCount: 0 };
  for (const r of stock) out.set(r.branch_id, { ...at(r.branch_id), cogs: dec(r.cogs), wastage: dec(r.wastage) });
  for (const r of exp) out.set(r.branch_id, { ...at(r.branch_id), expenses: dec(r.amount), expenseTax: dec(r.tax), expenseCount: r.n });
  return out;
}

export const sumCosts = (m: Map<string, CostFacts>): CostFacts =>
  [...m.values()].reduce(
    (a, c) => ({ cogs: a.cogs.add(c.cogs), wastage: a.wastage.add(c.wastage), expenses: a.expenses.add(c.expenses), expenseTax: a.expenseTax.add(c.expenseTax), expenseCount: a.expenseCount + c.expenseCount }),
    { cogs: ZERO, wastage: ZERO, expenses: ZERO, expenseTax: ZERO, expenseCount: 0 },
  );

export interface ProductLine {
  productId: string;
  name: string;
  categoryId: string;
  category: string;
  quantity: D;
  gross: D;
  discount: D;
  taxable: D;
  tax: D;
  total: D;
  creditedQuantity: D;
  creditedTaxable: D;
  creditedTax: D;
  creditedTotal: D;
}

/**
 * Item sales per product: invoiced lines on the invoice date minus credit-note lines on the credit
 * note date. Service-charge lines (no product) are returned separately.
 */
export async function productSales(prisma: PrismaService, org: string, branchIds: string[], p: Period) {
  const [sold, credited] = await Promise.all([
    prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT oi.product_id::text AS product_id, sum(ii.quantity) AS qty, sum(coalesce(oi.line_subtotal, 0)) AS gross, sum(ii.discount) AS discount,
        sum(ii.taxable_amount) AS taxable, sum(ii.cgst_amount + ii.sgst_amount + ii.igst_amount) AS tax, sum(ii.line_total) AS total
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii.invoice_id
      LEFT JOIN order_items oi ON oi.id = ii.order_item_id
      WHERE i.organization_id = ${org}::uuid AND i.branch_id = ANY(${branchIds}::uuid[]) AND i.status IN ('FINALIZED', 'CANCELLED')
        AND i.invoice_date >= ${p.gte} AND i.invoice_date < ${p.lt}
      GROUP BY 1`,
    prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT oi.product_id::text AS product_id, sum(cni.quantity) AS qty, sum(cni.taxable_amount) AS taxable, sum(cni.tax_amount) AS tax, sum(cni.line_total) AS total
      FROM credit_note_items cni
      JOIN credit_notes c ON c.id = cni.credit_note_id
      JOIN invoice_items ii ON ii.id = cni.invoice_item_id
      LEFT JOIN order_items oi ON oi.id = ii.order_item_id
      WHERE c.organization_id = ${org}::uuid AND c.branch_id = ANY(${branchIds}::uuid[]) AND c.created_at >= ${p.gte} AND c.created_at < ${p.lt}
      GROUP BY 1`,
  ]);
  const ids = [...new Set([...sold, ...credited].map((r) => r.product_id as string | null).filter((x): x is string => !!x))];
  const products = await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, categoryId: true, category: { select: { name: true } } } });
  const info = new Map(products.map((x) => [x.id, x]));
  const lines = new Map<string, ProductLine>();
  const service = { taxable: ZERO, tax: ZERO, total: ZERO, creditedTaxable: ZERO, creditedTax: ZERO, creditedTotal: ZERO };
  const line = (id: string) => {
    let l = lines.get(id);
    if (!l) {
      const pr = info.get(id);
      l = {
        productId: id,
        name: pr?.name ?? 'Unknown product',
        categoryId: pr?.categoryId ?? '',
        category: pr?.category.name ?? 'Uncategorised',
        quantity: ZERO,
        gross: ZERO,
        discount: ZERO,
        taxable: ZERO,
        tax: ZERO,
        total: ZERO,
        creditedQuantity: ZERO,
        creditedTaxable: ZERO,
        creditedTax: ZERO,
        creditedTotal: ZERO,
      };
      lines.set(id, l);
    }
    return l;
  };
  for (const r of sold) {
    if (!r.product_id) {
      service.taxable = dec(r.taxable);
      service.tax = dec(r.tax);
      service.total = dec(r.total);
      continue;
    }
    Object.assign(line(r.product_id as string), { quantity: dec(r.qty), gross: dec(r.gross), discount: dec(r.discount), taxable: dec(r.taxable), tax: dec(r.tax), total: dec(r.total) });
  }
  for (const r of credited) {
    if (!r.product_id) {
      service.creditedTaxable = dec(r.taxable);
      service.creditedTax = dec(r.tax);
      service.creditedTotal = dec(r.total);
      continue;
    }
    Object.assign(line(r.product_id as string), { creditedQuantity: dec(r.qty), creditedTaxable: dec(r.taxable), creditedTax: dec(r.tax), creditedTotal: dec(r.total) });
  }
  return { lines: [...lines.values()], service };
}

export const netOf = (l: ProductLine) => ({
  quantity: l.quantity.sub(l.creditedQuantity),
  sales: l.taxable.sub(l.creditedTaxable),
  tax: l.tax.sub(l.creditedTax),
  total: l.total.sub(l.creditedTotal),
});
