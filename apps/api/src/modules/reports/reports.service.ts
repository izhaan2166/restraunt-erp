import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthPrincipal } from '../auth/principal';
import { Grouping, ReportQuery, SalesReportQuery } from './dto/reports.dto';
import { Fact, derived, emptyFact, netOf, productSales, rollUp, salesFacts, total } from './facts';
import { Column, D, Report, Row, SummaryItem, ZERO, capped, dec, istStamp, money, pct, qty, ratio } from './report';
import { BranchRef, Period, period, reportBranches } from './scope';

export const DAY_MS = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Period start dates from..to for daily/weekly/monthly/annual rows (weeks start Monday). */
export function bucketKeys(from: string, to: string, unit: Grouping): string[] {
  const end = new Date(`${to}T00:00:00Z`).getTime();
  let d = new Date(`${from}T00:00:00Z`);
  if (unit === 'week') d = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY_MS);
  if (unit === 'month') d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  if (unit === 'year') d = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const out: string[] = [];
  while (d.getTime() <= end) {
    out.push(iso(d));
    if (unit === 'day') d = new Date(d.getTime() + DAY_MS);
    else if (unit === 'week') d = new Date(d.getTime() + 7 * DAY_MS);
    else if (unit === 'month') d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    else d = new Date(Date.UTC(d.getUTCFullYear() + 1, 0, 1));
  }
  return out;
}

export const SALES_COLUMNS: Column[] = [
  { key: 'invoices', label: 'Bills', type: 'number' },
  { key: 'grossSales', label: 'Gross sales', type: 'money' },
  { key: 'discounts', label: 'Discounts', type: 'money' },
  { key: 'serviceCharge', label: 'Service charge', type: 'money' },
  { key: 'creditNotes', label: 'Credit notes', type: 'money' },
  { key: 'netSales', label: 'Net sales', type: 'money' },
  { key: 'netTax', label: 'GST', type: 'money' },
  { key: 'netBilled', label: 'Billed (incl. GST)', type: 'money' },
  { key: 'collected', label: 'Collected', type: 'money' },
  { key: 'refunded', label: 'Refunded', type: 'money' },
  { key: 'netCollected', label: 'Net collected', type: 'money' },
];

export function salesRow(f: Fact): Row {
  const d = derived(f);
  return {
    invoices: f.invoices,
    grossSales: money(f.gross),
    discounts: money(f.discounts),
    serviceCharge: money(f.serviceCharge),
    creditNotes: money(f.cnTaxable),
    netSales: money(d.netSales),
    netTax: money(d.netTax),
    netBilled: money(d.netBilled),
    collected: money(f.collected),
    refunded: money(f.refunded),
    netCollected: money(d.netCollected),
  };
}

function salesSummary(f: Fact): SummaryItem[] {
  const d = derived(f);
  return [
    { key: 'invoices', label: 'Bills issued', value: f.invoices, type: 'number' },
    { key: 'cancelledInvoices', label: 'Bills cancelled', value: f.cancelledInvoices, type: 'number' },
    { key: 'grossSales', label: 'Gross sales (before discounts)', value: money(f.gross), type: 'money' },
    { key: 'discounts', label: 'Discounts', value: money(f.discounts), type: 'money' },
    { key: 'serviceCharge', label: 'Service charge', value: money(f.serviceCharge), type: 'money' },
    { key: 'taxableSales', label: 'Taxable value billed', value: money(f.taxable), type: 'money' },
    { key: 'creditNotes', label: 'Credit notes (taxable value)', value: money(f.cnTaxable), type: 'money' },
    { key: 'netSales', label: 'Net sales (excl. GST)', value: money(d.netSales), type: 'money' },
    { key: 'cgst', label: 'CGST', value: money(f.cgst.sub(f.cnCgst)), type: 'money' },
    { key: 'sgst', label: 'SGST', value: money(f.sgst.sub(f.cnSgst)), type: 'money' },
    { key: 'igst', label: 'IGST', value: money(f.igst.sub(f.cnIgst)), type: 'money' },
    { key: 'netTax', label: 'GST collected', value: money(d.netTax), type: 'money' },
    { key: 'roundOff', label: 'Round off', value: money(f.roundOff), type: 'money' },
    { key: 'netBilled', label: 'Billed incl. GST (after credit notes)', value: money(d.netBilled), type: 'money' },
    { key: 'averageBill', label: 'Average bill', value: ratio(f.finalBilled, f.invoices), type: 'money' },
    { key: 'collected', label: 'Payments collected', value: money(f.collected), type: 'money' },
    { key: 'refunded', label: 'Refunds paid', value: money(f.refunded), type: 'money' },
    { key: 'netCollected', label: 'Net collected', value: money(d.netCollected), type: 'money' },
  ];
}

/** Every report and the dashboard. All figures are read from the records; nothing is stored. */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private async scope(actor: AuthPrincipal, perms: string[], q: { branchId?: string; from: string; to: string }) {
    const p = period(q.from, q.to);
    const branches = await reportBranches(this.prisma, actor, perms, q.branchId);
    return { p, branches, ids: branches.map((b) => b.id), org: actor.organizationId };
  }

  private base(key: string, title: string, p: Period, branches: BranchRef[]): Omit<Report, 'summary' | 'tables'> {
    return { key, title, from: p.from, to: p.to, branches };
  }

  // ───────────── Sales ─────────────

  async sales(actor: AuthPrincipal, q: SalesReportQuery): Promise<Report> {
    const { p, branches, ids, org } = await this.scope(actor, ['reports.sales'], q);
    const unit = q.groupBy ?? 'day';
    const byBucket = rollUp(await salesFacts(this.prisma, org, ids, p, unit), 'bucket');
    const rows = bucketKeys(p.from, p.to, unit).map((k) => ({ period: k, ...salesRow(byBucket.get(k) ?? emptyFact()) }));
    const titles: Record<Grouping, string> = { day: 'Daily sales', week: 'Weekly sales', month: 'Monthly sales', year: 'Annual sales' };
    return {
      ...this.base('sales', titles[unit], p, branches),
      summary: salesSummary(total(byBucket)),
      tables: [{ key: 'rows', title: titles[unit], columns: [{ key: 'period', label: unit === 'day' ? 'Date' : 'Period from' }, ...SALES_COLUMNS], rows }],
      notes: ['Sales count on the bill date and credit notes on their own date. Net sales exclude GST. Collected counts payments on the day they were received.'],
    };
  }

  async products(actor: AuthPrincipal, q: ReportQuery): Promise<Report> {
    const { p, branches, ids, org } = await this.scope(actor, ['reports.sales'], q);
    const { lines, service } = await productSales(this.prisma, org, ids, p);
    const itemsNet = lines.reduce((a, l) => a.add(netOf(l).sales), ZERO);
    const serviceNet = service.taxable.sub(service.creditedTaxable);
    const rows = lines
      .map((l) => ({ l, n: netOf(l) }))
      .sort((a, b) => b.n.sales.cmp(a.n.sales) || a.l.name.localeCompare(b.l.name))
      .map(({ l, n }) => ({
        productId: l.productId,
        product: l.name,
        category: l.category,
        quantity: qty(n.quantity),
        grossSales: money(l.gross),
        discounts: money(l.discount),
        credited: money(l.creditedTaxable),
        netSales: money(n.sales),
        tax: money(n.tax),
        total: money(n.total),
        share: pct(n.sales, itemsNet),
      }));
    return {
      ...this.base('products', 'Product-wise sales', p, branches),
      summary: [
        { key: 'products', label: 'Products sold', value: rows.length, type: 'number' },
        { key: 'itemsNetSales', label: 'Item sales (excl. GST)', value: money(itemsNet), type: 'money' },
        { key: 'serviceChargeNet', label: 'Service charge', value: money(serviceNet), type: 'money' },
        { key: 'netSales', label: 'Net sales (excl. GST)', value: money(itemsNet.add(serviceNet)), type: 'money' },
      ],
      tables: [
        {
          key: 'rows',
          title: 'Products',
          columns: [
            { key: 'product', label: 'Product' },
            { key: 'category', label: 'Category' },
            { key: 'quantity', label: 'Qty', type: 'qty' },
            { key: 'grossSales', label: 'Gross', type: 'money' },
            { key: 'discounts', label: 'Discounts', type: 'money' },
            { key: 'credited', label: 'Credited', type: 'money' },
            { key: 'netSales', label: 'Net sales', type: 'money' },
            { key: 'tax', label: 'GST', type: 'money' },
            { key: 'total', label: 'Total', type: 'money' },
            { key: 'share', label: 'Share', type: 'percent' },
          ],
          rows,
        },
      ],
      notes: ['Quantities and amounts are net of credit notes. Gross is the menu value before discounts (GST included on GST-inclusive branches).'],
    };
  }

  async categories(actor: AuthPrincipal, q: ReportQuery): Promise<Report> {
    const { p, branches, ids, org } = await this.scope(actor, ['reports.sales'], q);
    const { lines, service } = await productSales(this.prisma, org, ids, p);
    const by = new Map<string, { category: string; products: number; quantity: D; gross: D; discount: D; credited: D; sales: D; tax: D; total: D }>();
    for (const l of lines) {
      const n = netOf(l);
      const c = by.get(l.categoryId) ?? { category: l.category, products: 0, quantity: ZERO, gross: ZERO, discount: ZERO, credited: ZERO, sales: ZERO, tax: ZERO, total: ZERO };
      by.set(l.categoryId, {
        category: c.category,
        products: c.products + 1,
        quantity: c.quantity.add(n.quantity),
        gross: c.gross.add(l.gross),
        discount: c.discount.add(l.discount),
        credited: c.credited.add(l.creditedTaxable),
        sales: c.sales.add(n.sales),
        tax: c.tax.add(n.tax),
        total: c.total.add(n.total),
      });
    }
    const itemsNet = [...by.values()].reduce((a, c) => a.add(c.sales), ZERO);
    const rows = [...by.values()]
      .sort((a, b) => b.sales.cmp(a.sales))
      .map((c) => ({ category: c.category, products: c.products, quantity: qty(c.quantity), grossSales: money(c.gross), discounts: money(c.discount), credited: money(c.credited), netSales: money(c.sales), tax: money(c.tax), total: money(c.total), share: pct(c.sales, itemsNet) }));
    return {
      ...this.base('categories', 'Category-wise sales', p, branches),
      summary: [
        { key: 'categories', label: 'Categories', value: rows.length, type: 'number' },
        { key: 'itemsNetSales', label: 'Item sales (excl. GST)', value: money(itemsNet), type: 'money' },
        { key: 'serviceChargeNet', label: 'Service charge', value: money(service.taxable.sub(service.creditedTaxable)), type: 'money' },
      ],
      tables: [
        {
          key: 'rows',
          title: 'Categories',
          columns: [
            { key: 'category', label: 'Category' },
            { key: 'products', label: 'Products', type: 'number' },
            { key: 'quantity', label: 'Qty', type: 'qty' },
            { key: 'grossSales', label: 'Gross', type: 'money' },
            { key: 'discounts', label: 'Discounts', type: 'money' },
            { key: 'credited', label: 'Credited', type: 'money' },
            { key: 'netSales', label: 'Net sales', type: 'money' },
            { key: 'tax', label: 'GST', type: 'money' },
            { key: 'total', label: 'Total', type: 'money' },
            { key: 'share', label: 'Share', type: 'percent' },
          ],
          rows,
        },
      ],
    };
  }

  // ───────────── GST ─────────────

  async gst(actor: AuthPrincipal, q: ReportQuery): Promise<Report> {
    const { p, branches, ids, org } = await this.scope(actor, ['reports.gst'], q);
    const facts = await salesFacts(this.prisma, org, ids, p);
    const [byRateHsn, cnByRateHsn, b2b, gstins] = await Promise.all([
      this.prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT (ii.cgst_rate + ii.sgst_rate + ii.igst_rate) AS rate, coalesce(ii.hsn_sac, '') AS hsn, sum(ii.quantity) AS qty, sum(ii.taxable_amount) AS taxable,
          sum(ii.cgst_amount) AS cgst, sum(ii.sgst_amount) AS sgst, sum(ii.igst_amount) AS igst
        FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
        WHERE i.organization_id = ${org}::uuid AND i.branch_id = ANY(${ids}::uuid[]) AND i.status IN ('FINALIZED', 'CANCELLED')
          AND i.invoice_date >= ${p.gte} AND i.invoice_date < ${p.lt}
        GROUP BY 1, 2`,
      this.prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT (ii.cgst_rate + ii.sgst_rate + ii.igst_rate) AS rate, coalesce(ii.hsn_sac, '') AS hsn, sum(cni.quantity) AS qty, sum(cni.taxable_amount) AS taxable, sum(cni.tax_amount) AS tax
        FROM credit_note_items cni JOIN credit_notes c ON c.id = cni.credit_note_id JOIN invoice_items ii ON ii.id = cni.invoice_item_id
        WHERE c.organization_id = ${org}::uuid AND c.branch_id = ANY(${ids}::uuid[]) AND c.created_at >= ${p.gte} AND c.created_at < ${p.lt}
        GROUP BY 1, 2`,
      this.prisma.invoice.findMany({
        where: { organizationId: org, branchId: { in: ids }, status: { in: ['FINALIZED', 'CANCELLED'] }, buyerGstin: { not: null }, invoiceDate: { gte: p.gte, lt: p.lt } },
        select: { invoiceNumber: true, invoiceDate: true, buyerName: true, buyerGstin: true, placeOfSupply: true, status: true, taxableAmount: true, taxTotal: true, grandTotal: true },
        orderBy: { invoiceDate: 'asc' },
      }),
      this.prisma.branch.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, gstin: true, stateCode: true, organization: { select: { gstin: true } } } }),
    ]);

    type RateRow = { rate: D; taxable: D; cgst: D; sgst: D; igst: D; cnTaxable: D; cnTax: D };
    const rates = new Map<string, RateRow>();
    const hsns = new Map<string, { hsn: string; rate: D; qty: D; taxable: D; tax: D }>();
    const rateRow = (r: D) => rates.get(r.toString()) ?? { rate: r, taxable: ZERO, cgst: ZERO, sgst: ZERO, igst: ZERO, cnTaxable: ZERO, cnTax: ZERO };
    const hsnRow = (h: string, r: D) => hsns.get(`${h}|${r}`) ?? { hsn: h, rate: r, qty: ZERO, taxable: ZERO, tax: ZERO };
    for (const x of byRateHsn) {
      const r = dec(x.rate);
      const cur = rateRow(r);
      const tax = dec(x.cgst).add(dec(x.sgst)).add(dec(x.igst));
      rates.set(r.toString(), { ...cur, taxable: cur.taxable.add(dec(x.taxable)), cgst: cur.cgst.add(dec(x.cgst)), sgst: cur.sgst.add(dec(x.sgst)), igst: cur.igst.add(dec(x.igst)) });
      const h = hsnRow(String(x.hsn), r);
      hsns.set(`${h.hsn}|${r}`, { ...h, qty: h.qty.add(dec(x.qty)), taxable: h.taxable.add(dec(x.taxable)), tax: h.tax.add(tax) });
    }
    for (const x of cnByRateHsn) {
      const r = dec(x.rate);
      const cur = rateRow(r);
      rates.set(r.toString(), { ...cur, cnTaxable: cur.cnTaxable.add(dec(x.taxable)), cnTax: cur.cnTax.add(dec(x.tax)) });
      const h = hsnRow(String(x.hsn), r);
      hsns.set(`${h.hsn}|${r}`, { ...h, qty: h.qty.sub(dec(x.qty)), taxable: h.taxable.sub(dec(x.taxable)), tax: h.tax.sub(dec(x.tax)) });
    }

    const all = total(facts);
    const perBranch = rollUp(facts, 'branch');
    return {
      ...this.base('gst', 'GST report', p, branches),
      summary: [
        { key: 'invoices', label: 'Bills issued', value: all.invoices, type: 'number' },
        { key: 'creditNotes', label: 'Credit notes', value: all.creditNotes, type: 'number' },
        { key: 'taxableValue', label: 'Taxable value billed', value: money(all.taxable), type: 'money' },
        { key: 'creditedTaxableValue', label: 'Taxable value credited', value: money(all.cnTaxable), type: 'money' },
        { key: 'netTaxableValue', label: 'Net taxable value', value: money(all.taxable.sub(all.cnTaxable)), type: 'money' },
        { key: 'cgst', label: 'CGST (net)', value: money(all.cgst.sub(all.cnCgst)), type: 'money' },
        { key: 'sgst', label: 'SGST (net)', value: money(all.sgst.sub(all.cnSgst)), type: 'money' },
        { key: 'igst', label: 'IGST (net)', value: money(all.igst.sub(all.cnIgst)), type: 'money' },
        { key: 'netTax', label: 'Total GST (net)', value: money(all.tax.sub(all.cnTax)), type: 'money' },
      ],
      tables: [
        {
          key: 'byRate',
          title: 'By tax rate',
          columns: [
            { key: 'rate', label: 'Rate %', type: 'number' },
            { key: 'taxable', label: 'Taxable', type: 'money' },
            { key: 'cgst', label: 'CGST', type: 'money' },
            { key: 'sgst', label: 'SGST', type: 'money' },
            { key: 'igst', label: 'IGST', type: 'money' },
            { key: 'creditedTaxable', label: 'Credited taxable', type: 'money' },
            { key: 'creditedTax', label: 'Credited GST', type: 'money' },
            { key: 'netTaxable', label: 'Net taxable', type: 'money' },
            { key: 'netTax', label: 'Net GST', type: 'money' },
          ],
          rows: [...rates.values()]
            .sort((a, b) => a.rate.cmp(b.rate))
            .map((r) => ({
              rate: r.rate.toString(),
              taxable: money(r.taxable),
              cgst: money(r.cgst),
              sgst: money(r.sgst),
              igst: money(r.igst),
              creditedTaxable: money(r.cnTaxable),
              creditedTax: money(r.cnTax),
              netTaxable: money(r.taxable.sub(r.cnTaxable)),
              netTax: money(r.cgst.add(r.sgst).add(r.igst).sub(r.cnTax)),
            })),
        },
        {
          key: 'byHsn',
          title: 'HSN/SAC summary (net of credit notes)',
          columns: [
            { key: 'hsn', label: 'HSN/SAC' },
            { key: 'rate', label: 'Rate %', type: 'number' },
            { key: 'quantity', label: 'Qty', type: 'qty' },
            { key: 'taxable', label: 'Taxable', type: 'money' },
            { key: 'tax', label: 'GST', type: 'money' },
          ],
          rows: [...hsns.values()]
            .sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate.cmp(b.rate))
            .map((h) => ({ hsn: h.hsn || null, rate: h.rate.toString(), quantity: qty(h.qty), taxable: money(h.taxable), tax: money(h.tax) })),
        },
        {
          key: 'byGstin',
          title: 'By branch GSTIN',
          columns: [
            { key: 'branch', label: 'Branch' },
            { key: 'gstin', label: 'GSTIN' },
            { key: 'stateCode', label: 'State' },
            { key: 'netTaxable', label: 'Net taxable', type: 'money' },
            { key: 'cgst', label: 'CGST', type: 'money' },
            { key: 'sgst', label: 'SGST', type: 'money' },
            { key: 'igst', label: 'IGST', type: 'money' },
          ],
          rows: gstins
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((b) => {
              const f = perBranch.get(b.id) ?? emptyFact();
              return { branch: b.name, gstin: b.gstin ?? b.organization.gstin ?? null, stateCode: b.stateCode, netTaxable: money(f.taxable.sub(f.cnTaxable)), cgst: money(f.cgst.sub(f.cnCgst)), sgst: money(f.sgst.sub(f.cnSgst)), igst: money(f.igst.sub(f.cnIgst)) };
            }),
        },
        capped(
          'b2b',
          'B2B bills (buyer GSTIN)',
          [
            { key: 'invoiceNumber', label: 'Bill no.' },
            { key: 'date', label: 'Date' },
            { key: 'buyer', label: 'Buyer' },
            { key: 'buyerGstin', label: 'Buyer GSTIN' },
            { key: 'placeOfSupply', label: 'Place' },
            { key: 'status', label: 'Status' },
            { key: 'taxable', label: 'Taxable', type: 'money' },
            { key: 'tax', label: 'GST', type: 'money' },
            { key: 'total', label: 'Total', type: 'money' },
          ],
          b2b.map((i) => ({ invoiceNumber: i.invoiceNumber, date: istStamp(i.invoiceDate)!.slice(0, 10), buyer: i.buyerName, buyerGstin: i.buyerGstin, placeOfSupply: i.placeOfSupply, status: i.status, taxable: money(i.taxableAmount), tax: money(i.taxTotal), total: money(i.grandTotal) })),
        ),
      ],
      notes: ['Bills count on the bill date and credit notes on their own date. Check the figures with your tax adviser before filing.'],
    };
  }

  // ───────────── Discounts, refunds, cancellations, payments ─────────────

  async discounts(actor: AuthPrincipal, q: ReportQuery): Promise<Report> {
    const { p, branches, ids, org } = await this.scope(actor, ['reports.sales'], q);
    const [invoices, applied] = await Promise.all([
      this.prisma.invoice.findMany({
        where: { organizationId: org, branchId: { in: ids }, status: 'FINALIZED', invoiceDate: { gte: p.gte, lt: p.lt } },
        select: { orderId: true, invoiceNumber: true, invoiceDate: true, subtotal: true, discountTotal: true },
        orderBy: { invoiceDate: 'asc' },
      }),
      this.prisma.$queryRaw<{ order_id: string; applied_by: string; approved_by: string | null; name: string; type: string; scope: string; value: unknown; amount: unknown; reason: string | null }[]>`
        SELECT ad.order_id::text AS order_id, ua.full_name AS applied_by, up.full_name AS approved_by, coalesce(d.name, 'Manual') AS name, ad.type::text AS type, ad.scope::text AS scope,
          ad.value, ad.amount, ad.reason
        FROM applied_discounts ad
        JOIN invoices i ON i.order_id = ad.order_id AND i.status = 'FINALIZED'
        JOIN users ua ON ua.id = ad.applied_by_id
        LEFT JOIN users up ON up.id = ad.approved_by_id
        LEFT JOIN discounts d ON d.id = ad.discount_id
        WHERE i.organization_id = ${org}::uuid AND i.branch_id = ANY(${ids}::uuid[]) AND i.invoice_date >= ${p.gte} AND i.invoice_date < ${p.lt} AND ad.amount > 0`,
    ]);
    const gross = invoices.reduce((a, i) => a.add(i.subtotal), ZERO);
    const given = invoices.reduce((a, i) => a.add(i.discountTotal), ZERO);
    const discounted = invoices.filter((i) => i.discountTotal.gt(0));
    const byOrder = new Map<string, typeof applied>();
    for (const a of applied) byOrder.set(a.order_id, [...(byOrder.get(a.order_id) ?? []), a]);
    const group = (key: (a: (typeof applied)[number]) => string) => {
      const m = new Map<string, { n: number; amount: D }>();
      for (const a of applied) {
        const k = key(a);
        const cur = m.get(k) ?? { n: 0, amount: ZERO };
        m.set(k, { n: cur.n + 1, amount: cur.amount.add(dec(a.amount)) });
      }
      return [...m.entries()].sort((x, y) => y[1].amount.cmp(x[1].amount));
    };
    return {
      ...this.base('discounts', 'Discounts', p, branches),
      summary: [
        { key: 'invoices', label: 'Bills', value: invoices.length, type: 'number' },
        { key: 'discountedInvoices', label: 'Bills with a discount', value: discounted.length, type: 'number' },
        { key: 'grossSales', label: 'Gross sales', value: money(gross), type: 'money' },
        { key: 'discounts', label: 'Discounts given', value: money(given), type: 'money' },
        { key: 'discountRate', label: 'Discount as % of gross', value: pct(given, gross), type: 'percent' },
      ],
      tables: [
        {
          key: 'byUser',
          title: 'By staff member',
          columns: [
            { key: 'user', label: 'Given by' },
            { key: 'count', label: 'Discounts', type: 'number' },
            { key: 'amount', label: 'Amount', type: 'money' },
          ],
          rows: group((a) => a.applied_by).map(([user, v]) => ({ user, count: v.n, amount: money(v.amount) })),
        },
        {
          key: 'byType',
          title: 'By discount',
          columns: [
            { key: 'discount', label: 'Discount' },
            { key: 'count', label: 'Times', type: 'number' },
            { key: 'amount', label: 'Amount', type: 'money' },
          ],
          rows: group((a) => `${a.name} (${a.scope === 'ITEM' ? 'item' : 'bill'}, ${a.type === 'PERCENTAGE' ? `${dec(a.value).toString()}%` : `Rs. ${money(dec(a.value))}`})`).map(([discount, v]) => ({ discount, count: v.n, amount: money(v.amount) })),
        },
        capped(
          'invoices',
          'Discounted bills',
          [
            { key: 'invoiceNumber', label: 'Bill no.' },
            { key: 'date', label: 'Date' },
            { key: 'grossSales', label: 'Gross', type: 'money' },
            { key: 'discount', label: 'Discount', type: 'money' },
            { key: 'givenBy', label: 'Given by' },
            { key: 'approvedBy', label: 'Approved by' },
            { key: 'reason', label: 'Reason' },
          ],
          discounted.map((i) => {
            const ds = byOrder.get(i.orderId) ?? [];
            const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))].join(', ') || null;
            return { invoiceNumber: i.invoiceNumber, date: istStamp(i.invoiceDate), grossSales: money(i.subtotal), discount: money(i.discountTotal), givenBy: uniq(ds.map((d) => d.applied_by)), approvedBy: uniq(ds.map((d) => d.approved_by)), reason: uniq(ds.map((d) => d.reason)) };
          }),
        ),
      ],
      notes: ['Discounts on bills that are still final, by bill date.'],
    };
  }

  async refunds(actor: AuthPrincipal, q: ReportQuery): Promise<Report> {
    const { p, branches, ids, org } = await this.scope(actor, ['reports.financial'], q);
    const [refunds, notes] = await Promise.all([
      this.prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT r.created_at, i.invoice_number, r.method::text AS method, r.amount, r.status::text AS status, r.reason, r.restock,
          up.full_name AS processed_by, ua.full_name AS approved_by, cn.credit_note_number
        FROM refunds r
        JOIN invoices i ON i.id = r.invoice_id
        JOIN users up ON up.id = r.processed_by_id
        LEFT JOIN users ua ON ua.id = r.approved_by_id
        LEFT JOIN credit_notes cn ON cn.id = r.credit_note_id
        WHERE r.organization_id = ${org}::uuid AND r.branch_id = ANY(${ids}::uuid[]) AND r.created_at >= ${p.gte} AND r.created_at < ${p.lt}
        ORDER BY r.created_at`,
      this.prisma.creditNote.aggregate({ where: { organizationId: org, branchId: { in: ids }, createdAt: { gte: p.gte, lt: p.lt } }, _count: true, _sum: { totalAmount: true } }),
    ]);
    const sumBy = (pred: (r: Record<string, unknown>) => boolean) => {
      const rs = refunds.filter(pred);
      return { n: rs.length, amount: rs.reduce((a, r) => a.add(dec(r.amount)), ZERO) };
    };
    const done = sumBy((r) => r.status === 'COMPLETED');
    const pending = sumBy((r) => r.status === 'PENDING');
    const rejected = sumBy((r) => r.status === 'VOIDED');
    const methods = [...new Set(refunds.filter((r) => r.status === 'COMPLETED').map((r) => r.method as string))].sort();
    return {
      ...this.base('refunds', 'Refunds', p, branches),
      summary: [
        { key: 'completed', label: 'Refunds paid', value: done.n, type: 'number' },
        { key: 'completedAmount', label: 'Amount refunded', value: money(done.amount), type: 'money' },
        { key: 'pending', label: 'Waiting for approval', value: pending.n, type: 'number' },
        { key: 'pendingAmount', label: 'Amount waiting', value: money(pending.amount), type: 'money' },
        { key: 'rejected', label: 'Rejected', value: rejected.n, type: 'number' },
        { key: 'rejectedAmount', label: 'Amount rejected', value: money(rejected.amount), type: 'money' },
        { key: 'creditNotes', label: 'Credit notes issued', value: notes._count, type: 'number' },
        { key: 'creditNoteAmount', label: 'Credit note value', value: money(notes._sum.totalAmount), type: 'money' },
      ],
      tables: [
        {
          key: 'byMethod',
          title: 'Refunds paid by method',
          columns: [
            { key: 'method', label: 'Method' },
            { key: 'count', label: 'Refunds', type: 'number' },
            { key: 'amount', label: 'Amount', type: 'money' },
          ],
          rows: methods.map((m) => {
            const s = sumBy((r) => r.status === 'COMPLETED' && r.method === m);
            return { method: m, count: s.n, amount: money(s.amount) };
          }),
        },
        capped(
          'rows',
          'All refunds',
          [
            { key: 'date', label: 'Date' },
            { key: 'invoiceNumber', label: 'Bill no.' },
            { key: 'creditNote', label: 'Credit note' },
            { key: 'method', label: 'Method' },
            { key: 'amount', label: 'Amount', type: 'money' },
            { key: 'status', label: 'Status' },
            { key: 'restock', label: 'Restocked' },
            { key: 'reason', label: 'Reason' },
            { key: 'processedBy', label: 'Requested by' },
            { key: 'approvedBy', label: 'Decided by' },
          ],
          refunds.map((r) => ({
            date: istStamp(r.created_at as Date),
            invoiceNumber: r.invoice_number as string,
            creditNote: (r.credit_note_number as string | null) ?? null,
            method: r.method as string,
            amount: money(dec(r.amount)),
            status: r.status === 'VOIDED' ? 'REJECTED' : (r.status as string),
            restock: r.restock ? 'Yes' : 'No',
            reason: r.reason as string,
            processedBy: r.processed_by as string,
            approvedBy: (r.approved_by as string | null) ?? null,
          })),
        ),
      ],
      notes: ['Refunds count on the day they were requested; only paid (completed) refunds reduce collections.'],
    };
  }

  async cancellations(actor: AuthPrincipal, q: ReportQuery): Promise<Report> {
    const { p, branches, ids, org } = await this.scope(actor, ['reports.sales'], q);
    const [orders, items, invoices] = await Promise.all([
      this.prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT o.order_number, o.order_type::text AS order_type, o.cancelled_at, o.cancel_reason, u.full_name AS cancelled_by,
          coalesce((SELECT sum(oi.line_total) FROM order_items oi WHERE oi.order_id = o.id AND (oi.status = 'ACTIVE' OR oi.cancelled_at >= o.cancelled_at)), 0) AS value,
          EXISTS (SELECT 1 FROM kitchen_tickets k WHERE k.order_id = o.id) AS sent_to_kitchen
        FROM orders o LEFT JOIN users u ON u.id = o.cancelled_by_id
        WHERE o.organization_id = ${org}::uuid AND o.branch_id = ANY(${ids}::uuid[]) AND o.status = 'CANCELLED' AND o.cancelled_at >= ${p.gte} AND o.cancelled_at < ${p.lt}
        ORDER BY o.cancelled_at`,
      this.prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT o.order_number, oi.product_name, oi.variant_name, oi.quantity, oi.line_total, oi.cancelled_at, oi.cancel_reason, u.full_name AS cancelled_by,
          oi.kitchen_status::text AS kitchen_status
        FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN users u ON u.id = oi.cancelled_by_id
        WHERE o.organization_id = ${org}::uuid AND o.branch_id = ANY(${ids}::uuid[]) AND oi.status = 'CANCELLED'
          AND oi.cancelled_at >= ${p.gte} AND oi.cancelled_at < ${p.lt} AND (o.cancelled_at IS NULL OR oi.cancelled_at < o.cancelled_at)
        ORDER BY oi.cancelled_at`,
      this.prisma.invoice.findMany({
        where: { organizationId: org, branchId: { in: ids }, status: 'CANCELLED', updatedAt: { gte: p.gte, lt: p.lt } },
        select: { invoiceNumber: true, invoiceDate: true, grandTotal: true, updatedAt: true },
        orderBy: { updatedAt: 'asc' },
      }),
    ]);
    const orderValue = orders.reduce((a, o) => a.add(dec(o.value)), ZERO);
    const itemValue = items.reduce((a, i) => a.add(dec(i.line_total)), ZERO);
    const byUser = new Map<string, { orders: number; items: number; value: D }>();
    for (const o of orders) {
      const k = (o.cancelled_by as string | null) ?? 'Unknown';
      const c = byUser.get(k) ?? { orders: 0, items: 0, value: ZERO };
      byUser.set(k, { ...c, orders: c.orders + 1, value: c.value.add(dec(o.value)) });
    }
    for (const i of items) {
      const k = (i.cancelled_by as string | null) ?? 'Unknown';
      const c = byUser.get(k) ?? { orders: 0, items: 0, value: ZERO };
      byUser.set(k, { ...c, items: c.items + 1, value: c.value.add(dec(i.line_total)) });
    }
    return {
      ...this.base('cancellations', 'Cancelled orders and items', p, branches),
      summary: [
        { key: 'cancelledOrders', label: 'Orders cancelled', value: orders.length, type: 'number' },
        { key: 'cancelledOrderValue', label: 'Value of cancelled orders', value: money(orderValue), type: 'money' },
        { key: 'afterKitchen', label: 'Cancelled after reaching the kitchen', value: orders.filter((o) => o.sent_to_kitchen).length, type: 'number' },
        { key: 'cancelledItems', label: 'Items cancelled from live orders', value: items.length, type: 'number' },
        { key: 'cancelledItemValue', label: 'Value of cancelled items', value: money(itemValue), type: 'money' },
        { key: 'cancelledInvoices', label: 'Bills cancelled', value: invoices.length, type: 'number' },
      ],
      tables: [
        {
          key: 'byUser',
          title: 'By staff member',
          columns: [
            { key: 'user', label: 'Cancelled by' },
            { key: 'orders', label: 'Orders', type: 'number' },
            { key: 'items', label: 'Items', type: 'number' },
            { key: 'value', label: 'Value', type: 'money' },
          ],
          rows: [...byUser.entries()].sort((a, b) => b[1].value.cmp(a[1].value)).map(([user, v]) => ({ user, orders: v.orders, items: v.items, value: money(v.value) })),
        },
        capped(
          'orders',
          'Cancelled orders',
          [
            { key: 'orderNumber', label: 'Order' },
            { key: 'cancelledAt', label: 'Cancelled at' },
            { key: 'orderType', label: 'Type' },
            { key: 'value', label: 'Value', type: 'money' },
            { key: 'sentToKitchen', label: 'In kitchen' },
            { key: 'reason', label: 'Reason' },
            { key: 'cancelledBy', label: 'By' },
          ],
          orders.map((o) => ({ orderNumber: o.order_number as string, cancelledAt: istStamp(o.cancelled_at as Date), orderType: o.order_type as string, value: money(dec(o.value)), sentToKitchen: o.sent_to_kitchen ? 'Yes' : 'No', reason: (o.cancel_reason as string | null) ?? null, cancelledBy: (o.cancelled_by as string | null) ?? null })),
        ),
        capped(
          'items',
          'Cancelled items',
          [
            { key: 'orderNumber', label: 'Order' },
            { key: 'cancelledAt', label: 'Cancelled at' },
            { key: 'item', label: 'Item' },
            { key: 'quantity', label: 'Qty', type: 'qty' },
            { key: 'value', label: 'Value', type: 'money' },
            { key: 'kitchenStatus', label: 'Kitchen' },
            { key: 'reason', label: 'Reason' },
            { key: 'cancelledBy', label: 'By' },
          ],
          items.map((i) => ({
            orderNumber: i.order_number as string,
            cancelledAt: istStamp(i.cancelled_at as Date),
            item: [i.product_name, i.variant_name ? `(${i.variant_name as string})` : null].filter(Boolean).join(' '),
            quantity: qty(dec(i.quantity)),
            value: money(dec(i.line_total)),
            kitchenStatus: i.kitchen_status as string,
            reason: (i.cancel_reason as string | null) ?? null,
            cancelledBy: (i.cancelled_by as string | null) ?? null,
          })),
        ),
        capped(
          'invoices',
          'Cancelled bills',
          [
            { key: 'invoiceNumber', label: 'Bill no.' },
            { key: 'billedAt', label: 'Billed at' },
            { key: 'cancelledAt', label: 'Cancelled at' },
            { key: 'total', label: 'Total', type: 'money' },
          ],
          invoices.map((i) => ({ invoiceNumber: i.invoiceNumber, billedAt: istStamp(i.invoiceDate), cancelledAt: istStamp(i.updatedAt), total: money(i.grandTotal) })),
        ),
      ],
      notes: ['An order is valued at the items it still had when it was cancelled; items cancelled earlier are listed separately.'],
    };
  }

  async payments(actor: AuthPrincipal, q: ReportQuery): Promise<Report> {
    const { p, branches, ids, org } = await this.scope(actor, ['reports.financial'], q);
    const [pay, ref, byDay] = await Promise.all([
      this.prisma.$queryRaw<{ method: string; n: number; amount: unknown }[]>`
        SELECT method::text AS method, count(*)::int AS n, sum(amount) AS amount FROM payments
        WHERE organization_id = ${org}::uuid AND branch_id = ANY(${ids}::uuid[]) AND status = 'COMPLETED' AND received_at >= ${p.gte} AND received_at < ${p.lt}
        GROUP BY 1`,
      this.prisma.$queryRaw<{ method: string; n: number; amount: unknown }[]>`
        SELECT method::text AS method, count(*)::int AS n, sum(amount) AS amount FROM refunds
        WHERE organization_id = ${org}::uuid AND branch_id = ANY(${ids}::uuid[]) AND status = 'COMPLETED' AND created_at >= ${p.gte} AND created_at < ${p.lt}
        GROUP BY 1`,
      salesFacts(this.prisma, org, ids, p, 'day'),
    ]);
    const methods = [...new Set([...pay, ...ref].map((r) => r.method))].sort();
    const get = (xs: typeof pay, m: string) => xs.find((x) => x.method === m);
    const rows = methods.map((m) => {
      const a = get(pay, m);
      const b = get(ref, m);
      const received = dec(a?.amount);
      const refunded = dec(b?.amount);
      return { method: m, payments: a?.n ?? 0, received: money(received), refunds: b?.n ?? 0, refunded: money(refunded), net: money(received.sub(refunded)) };
    });
    const received = pay.reduce((s, x) => s.add(dec(x.amount)), ZERO);
    const refunded = ref.reduce((s, x) => s.add(dec(x.amount)), ZERO);
    const days = rollUp(byDay, 'bucket');
    return {
      ...this.base('payments', 'Payments by method', p, branches),
      summary: [
        { key: 'payments', label: 'Payments', value: pay.reduce((s, x) => s + x.n, 0), type: 'number' },
        { key: 'collected', label: 'Collected', value: money(received), type: 'money' },
        { key: 'refunded', label: 'Refunded', value: money(refunded), type: 'money' },
        { key: 'netCollected', label: 'Net collected', value: money(received.sub(refunded)), type: 'money' },
      ],
      tables: [
        {
          key: 'byMethod',
          title: 'By payment method',
          columns: [
            { key: 'method', label: 'Method' },
            { key: 'payments', label: 'Payments', type: 'number' },
            { key: 'received', label: 'Received', type: 'money' },
            { key: 'refunds', label: 'Refunds', type: 'number' },
            { key: 'refunded', label: 'Refunded', type: 'money' },
            { key: 'net', label: 'Net', type: 'money' },
          ],
          rows,
        },
        {
          key: 'byDay',
          title: 'By day',
          columns: [
            { key: 'date', label: 'Date' },
            { key: 'collected', label: 'Collected', type: 'money' },
            { key: 'refunded', label: 'Refunded', type: 'money' },
            { key: 'netCollected', label: 'Net', type: 'money' },
          ],
          rows: bucketKeys(p.from, p.to, 'day').map((d) => {
            const f = days.get(d) ?? emptyFact();
            return { date: d, collected: money(f.collected), refunded: money(f.refunded), netCollected: money(f.collected.sub(f.refunded)) };
          }),
        },
      ],
    };
  }
}
