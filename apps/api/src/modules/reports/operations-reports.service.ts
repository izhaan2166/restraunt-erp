import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthPrincipal } from '../auth/principal';
import { ReportQuery } from './dto/reports.dto';
import { CostFacts, Fact, costFacts, derived, emptyFact, orderCounts, rollUp, salesFacts, sumCosts, total } from './facts';
import { D, Report, ZERO, capped, dec, istStamp, money, pct, qty, ratio } from './report';
import { BranchRef, Period, period, reportBranches } from './scope';

const emptyCosts = (): CostFacts => ({ cogs: ZERO, wastage: ZERO, expenses: ZERO, expenseTax: ZERO, expenseCount: 0 });
/** Net sales − recipe cost − wastage − expenses. */
const profitOf = (f: Fact, c: CostFacts) => derived(f).netSales.sub(c.cogs).sub(c.wastage).sub(c.expenses);

/** Stock, purchasing, expense, profit, branch and staff reports. */
@Injectable()
export class OperationsReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private async scope(actor: AuthPrincipal, perms: string[], q: ReportQuery) {
    const p = period(q.from, q.to);
    const branches = await reportBranches(this.prisma, actor, perms, q.branchId);
    return { p, branches, ids: branches.map((b) => b.id), org: actor.organizationId };
  }

  private base(key: string, title: string, p: Period, branches: BranchRef[]) {
    return { key, title, from: p.from, to: p.to, branches };
  }

  /**
   * Stock movement summary per ingredient: opening + received − consumed − wasted ± adjustments ±
   * transfers = closing, with the value of what was used. Everything comes from the stock ledger.
   */
  async inventory(actor: AuthPrincipal, q: ReportQuery): Promise<Report> {
    const { p, branches, ids, org } = await this.scope(actor, ['reports.inventory'], q);
    const rows = await this.prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT g.id::text AS ingredient_id, g.name, u.code AS unit,
        coalesce(sum(m.quantity) FILTER (WHERE m.created_at < ${p.gte}), 0) AS opening,
        coalesce(sum(m.quantity) FILTER (WHERE m.created_at >= ${p.gte} AND m.type = 'PURCHASE_RECEIPT'), 0) AS received,
        coalesce(-sum(m.quantity) FILTER (WHERE m.created_at >= ${p.gte} AND m.type IN ('SALE_CONSUMPTION', 'SALE_REVERSAL')), 0) AS consumed,
        coalesce(-sum(m.quantity) FILTER (WHERE m.created_at >= ${p.gte} AND m.type = 'WASTAGE'), 0) AS wasted,
        coalesce(sum(m.quantity) FILTER (WHERE m.created_at >= ${p.gte} AND m.type IN ('OPENING', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT')), 0) AS adjusted,
        coalesce(sum(m.quantity) FILTER (WHERE m.created_at >= ${p.gte} AND m.type IN ('TRANSFER_IN', 'TRANSFER_OUT')), 0) AS transferred,
        coalesce(sum(m.quantity), 0) AS closing,
        coalesce(sum(round(abs(m.quantity) * coalesce(m.unit_cost, 0), 2)) FILTER (WHERE m.created_at >= ${p.gte} AND m.type = 'PURCHASE_RECEIPT'), 0) AS received_value,
        coalesce(sum(round(abs(m.quantity) * coalesce(m.unit_cost, 0), 2)) FILTER (WHERE m.created_at >= ${p.gte} AND m.type = 'SALE_CONSUMPTION'), 0)
          - coalesce(sum(round(abs(m.quantity) * coalesce(m.unit_cost, 0), 2)) FILTER (WHERE m.created_at >= ${p.gte} AND m.type = 'SALE_REVERSAL'), 0) AS consumed_value,
        coalesce(sum(round(abs(m.quantity) * coalesce(m.unit_cost, 0), 2)) FILTER (WHERE m.created_at >= ${p.gte} AND m.type = 'WASTAGE'), 0) AS wasted_value
      FROM stock_movements m JOIN ingredients g ON g.id = m.ingredient_id JOIN units u ON u.id = g.base_unit_id
      WHERE m.organization_id = ${org}::uuid AND m.branch_id = ANY(${ids}::uuid[]) AND m.created_at < ${p.lt}
      GROUP BY 1, 2, 3
      ORDER BY 2`;
    const sum = (k: string) => rows.reduce((a, r) => a.add(dec(r[k])), ZERO);
    return {
      ...this.base('inventory', 'Inventory consumption', p, branches),
      summary: [
        { key: 'ingredients', label: 'Ingredients', value: rows.length, type: 'number' },
        { key: 'receivedValue', label: 'Stock received (value)', value: money(sum('received_value')), type: 'money' },
        { key: 'consumedValue', label: 'Used in sales (recipe cost)', value: money(sum('consumed_value')), type: 'money' },
        { key: 'wastedValue', label: 'Wasted (value)', value: money(sum('wasted_value')), type: 'money' },
      ],
      tables: [
        {
          key: 'rows',
          title: 'Stock movement by ingredient',
          columns: [
            { key: 'ingredient', label: 'Ingredient' },
            { key: 'unit', label: 'Unit' },
            { key: 'opening', label: 'Opening', type: 'qty' },
            { key: 'received', label: 'Received', type: 'qty' },
            { key: 'consumed', label: 'Used in sales', type: 'qty' },
            { key: 'wasted', label: 'Wasted', type: 'qty' },
            { key: 'adjusted', label: 'Adjusted', type: 'qty' },
            { key: 'transferred', label: 'Transfers', type: 'qty' },
            { key: 'closing', label: 'Closing', type: 'qty' },
            { key: 'consumedValue', label: 'Used value', type: 'money' },
            { key: 'wastedValue', label: 'Wasted value', type: 'money' },
          ],
          rows: rows.map((r) => ({
            ingredientId: r.ingredient_id as string,
            ingredient: r.name as string,
            unit: r.unit as string,
            opening: qty(dec(r.opening)),
            received: qty(dec(r.received)),
            consumed: qty(dec(r.consumed)),
            wasted: qty(dec(r.wasted)),
            adjusted: qty(dec(r.adjusted)),
            transferred: qty(dec(r.transferred)),
            closing: qty(dec(r.closing)),
            receivedValue: money(dec(r.received_value)),
            consumedValue: money(dec(r.consumed_value)),
            wastedValue: money(dec(r.wasted_value)),
          })),
        },
      ],
      notes: ['Quantities are in each ingredient’s base unit. Values use the average cost at the time of each movement. Opening + received − used − wasted + adjusted + transfers = closing.'],
    };
  }

  async wastage(actor: AuthPrincipal, q: ReportQuery): Promise<Report> {
    const { p, branches, ids, org } = await this.scope(actor, ['reports.inventory'], q);
    const rows = await this.prisma.wastageRecord.findMany({
      where: { organizationId: org, branchId: { in: ids }, createdAt: { gte: p.gte, lt: p.lt } },
      include: { ingredient: { select: { id: true, name: true, baseUnit: { select: { code: true } } } }, branch: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.recordedById))] } }, select: { id: true, fullName: true } });
    const name = new Map(users.map((u) => [u.id, u.fullName]));
    const by = new Map<string, { ingredient: string; unit: string; records: number; quantity: D; cost: D }>();
    for (const r of rows) {
      const c = by.get(r.ingredientId) ?? { ingredient: r.ingredient.name, unit: r.ingredient.baseUnit.code, records: 0, quantity: ZERO, cost: ZERO };
      by.set(r.ingredientId, { ...c, records: c.records + 1, quantity: c.quantity.add(r.quantity), cost: c.cost.add(r.cost) });
    }
    const totalCost = rows.reduce((a, r) => a.add(r.cost), ZERO);
    return {
      ...this.base('wastage', 'Wastage', p, branches),
      summary: [
        { key: 'records', label: 'Wastage entries', value: rows.length, type: 'number' },
        { key: 'cost', label: 'Value wasted', value: money(totalCost), type: 'money' },
      ],
      tables: [
        {
          key: 'byIngredient',
          title: 'By ingredient',
          columns: [
            { key: 'ingredient', label: 'Ingredient' },
            { key: 'unit', label: 'Unit' },
            { key: 'records', label: 'Entries', type: 'number' },
            { key: 'quantity', label: 'Quantity', type: 'qty' },
            { key: 'cost', label: 'Value', type: 'money' },
            { key: 'share', label: 'Share', type: 'percent' },
          ],
          rows: [...by.values()].sort((a, b) => b.cost.cmp(a.cost)).map((c) => ({ ingredient: c.ingredient, unit: c.unit, records: c.records, quantity: qty(c.quantity), cost: money(c.cost), share: pct(c.cost, totalCost) })),
        },
        capped(
          'rows',
          'All entries',
          [
            { key: 'date', label: 'Date' },
            { key: 'branch', label: 'Branch' },
            { key: 'ingredient', label: 'Ingredient' },
            { key: 'quantity', label: 'Quantity', type: 'qty' },
            { key: 'unit', label: 'Unit' },
            { key: 'cost', label: 'Value', type: 'money' },
            { key: 'reason', label: 'Reason' },
            { key: 'recordedBy', label: 'By' },
          ],
          rows.map((r) => ({ date: istStamp(r.createdAt), branch: r.branch.name, ingredient: r.ingredient.name, quantity: qty(r.quantity), unit: r.ingredient.baseUnit.code, cost: money(r.cost), reason: r.reason, recordedBy: name.get(r.recordedById) ?? null })),
        ),
      ],
    };
  }

  /** Goods received, supplier bills and payments per supplier, plus what is owed today. */
  async purchases(actor: AuthPrincipal, q: ReportQuery): Promise<Report> {
    const { p, branches, ids, org } = await this.scope(actor, ['reports.inventory', 'reports.financial'], q);
    const [received, byIngredient, bills, paid, owed] = await Promise.all([
      this.prisma.$queryRaw<{ supplier_id: string; n: number; value: unknown }[]>`
        SELECT g.supplier_id::text AS supplier_id, count(DISTINCT g.id)::int AS n, coalesce(sum(round(gi.quantity * gi.unit_price, 2)), 0) AS value
        FROM goods_receipts g JOIN goods_receipt_items gi ON gi.goods_receipt_id = g.id
        WHERE g.organization_id = ${org}::uuid AND g.branch_id = ANY(${ids}::uuid[]) AND g.received_at >= ${p.gte} AND g.received_at < ${p.lt}
        GROUP BY 1`,
      this.prisma.$queryRaw<{ name: string; unit: string; qty: unknown; value: unknown }[]>`
        SELECT i.name, u.code AS unit, sum(gi.base_quantity) AS qty, coalesce(sum(round(gi.quantity * gi.unit_price, 2)), 0) AS value
        FROM goods_receipts g JOIN goods_receipt_items gi ON gi.goods_receipt_id = g.id JOIN ingredients i ON i.id = gi.ingredient_id JOIN units u ON u.id = i.base_unit_id
        WHERE g.organization_id = ${org}::uuid AND g.branch_id = ANY(${ids}::uuid[]) AND g.received_at >= ${p.gte} AND g.received_at < ${p.lt}
        GROUP BY 1, 2 ORDER BY 4 DESC, 1`,
      this.prisma.$queryRaw<{ supplier_id: string; n: number; subtotal: unknown; tax: unknown; total: unknown }[]>`
        SELECT supplier_id::text AS supplier_id, count(*)::int AS n, sum(subtotal) AS subtotal, sum(tax_total) AS tax, sum(total) AS total
        FROM supplier_invoices
        WHERE organization_id = ${org}::uuid AND branch_id = ANY(${ids}::uuid[]) AND status <> 'CANCELLED' AND invoice_date >= ${p.gte} AND invoice_date < ${p.lt}
        GROUP BY 1`,
      this.prisma.$queryRaw<{ supplier_id: string; n: number; amount: unknown }[]>`
        SELECT sp.supplier_id::text AS supplier_id, count(*)::int AS n, sum(sp.amount) AS amount
        FROM supplier_payments sp LEFT JOIN supplier_invoices si ON si.id = sp.supplier_invoice_id
        WHERE sp.organization_id = ${org}::uuid AND coalesce(sp.branch_id, si.branch_id) = ANY(${ids}::uuid[]) AND sp.paid_at >= ${p.gte} AND sp.paid_at < ${p.lt}
        GROUP BY 1`,
      this.prisma.$queryRaw<{ supplier_id: string; outstanding: unknown; overdue: unknown }[]>`
        SELECT supplier_id::text AS supplier_id, sum(total - paid_amount) AS outstanding,
          coalesce(sum(total - paid_amount) FILTER (WHERE due_date < now()), 0) AS overdue
        FROM supplier_invoices
        WHERE organization_id = ${org}::uuid AND branch_id = ANY(${ids}::uuid[]) AND status IN ('UNPAID', 'PARTIALLY_PAID')
        GROUP BY 1`,
    ]);
    const supplierIds = [...new Set([...received, ...bills, ...paid, ...owed].map((r) => r.supplier_id))];
    const suppliers = await this.prisma.supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, name: true, gstin: true } });
    const find = <T extends { supplier_id: string }>(xs: T[], id: string) => xs.find((x) => x.supplier_id === id);
    const rows = suppliers
      .map((s) => {
        const r = find(received, s.id);
        const b = find(bills, s.id);
        const y = find(paid, s.id);
        const o = find(owed, s.id);
        return {
          supplier: s.name,
          gstin: s.gstin,
          receipts: r?.n ?? 0,
          receivedValue: money(dec(r?.value)),
          bills: b?.n ?? 0,
          billedSubtotal: money(dec(b?.subtotal)),
          billedTax: money(dec(b?.tax)),
          billed: money(dec(b?.total)),
          paid: money(dec(y?.amount)),
          outstanding: money(dec(o?.outstanding)),
          overdue: money(dec(o?.overdue)),
        };
      })
      .sort((a, b) => dec(b.receivedValue).cmp(dec(a.receivedValue)) || a.supplier.localeCompare(b.supplier));
    const sum = <T>(xs: T[], f: (x: T) => unknown) => xs.reduce((a, x) => a.add(dec(f(x))), ZERO);
    return {
      ...this.base('purchases', 'Supplier purchases', p, branches),
      summary: [
        { key: 'receipts', label: 'Deliveries received', value: received.reduce((a, r) => a + r.n, 0), type: 'number' },
        { key: 'receivedValue', label: 'Goods received (before GST)', value: money(sum(received, (r) => r.value)), type: 'money' },
        { key: 'bills', label: 'Supplier bills', value: bills.reduce((a, r) => a + r.n, 0), type: 'number' },
        { key: 'billed', label: 'Billed by suppliers (incl. GST)', value: money(sum(bills, (r) => r.total)), type: 'money' },
        { key: 'inputTax', label: 'GST on supplier bills', value: money(sum(bills, (r) => r.tax)), type: 'money' },
        { key: 'paid', label: 'Paid to suppliers', value: money(sum(paid, (r) => r.amount)), type: 'money' },
        { key: 'outstanding', label: 'Owed to suppliers today', value: money(sum(owed, (r) => r.outstanding)), type: 'money' },
        { key: 'overdue', label: 'Of which overdue', value: money(sum(owed, (r) => r.overdue)), type: 'money' },
      ],
      tables: [
        {
          key: 'bySupplier',
          title: 'By supplier',
          columns: [
            { key: 'supplier', label: 'Supplier' },
            { key: 'receipts', label: 'Deliveries', type: 'number' },
            { key: 'receivedValue', label: 'Received', type: 'money' },
            { key: 'bills', label: 'Bills', type: 'number' },
            { key: 'billed', label: 'Billed', type: 'money' },
            { key: 'paid', label: 'Paid', type: 'money' },
            { key: 'outstanding', label: 'Owed now', type: 'money' },
            { key: 'overdue', label: 'Overdue', type: 'money' },
          ],
          rows,
        },
        {
          key: 'byIngredient',
          title: 'By ingredient received',
          columns: [
            { key: 'ingredient', label: 'Ingredient' },
            { key: 'unit', label: 'Unit' },
            { key: 'quantity', label: 'Quantity', type: 'qty' },
            { key: 'value', label: 'Value', type: 'money' },
            { key: 'averagePrice', label: 'Avg price / unit', type: 'money' },
          ],
          rows: byIngredient.map((r) => {
            const q = dec(r.qty);
            return { ingredient: r.name, unit: r.unit, quantity: qty(q), value: money(dec(r.value)), averagePrice: q.isZero() ? null : dec(r.value).div(q).toDecimalPlaces(4).toString() };
          }),
        },
      ],
      notes: ['Deliveries count on the day received (value before GST); bills on the bill date; payments on the payment date. "Owed now" is today’s balance, whatever the period.'],
    };
  }

  async expenses(actor: AuthPrincipal, q: ReportQuery): Promise<Report> {
    const { p, branches, ids, org } = await this.scope(actor, ['reports.financial'], q);
    const rows = await this.prisma.expense.findMany({
      where: { organizationId: org, branchId: { in: ids }, deletedAt: null, expenseDate: { gte: new Date(`${p.from}T00:00:00Z`), lte: new Date(`${p.to}T00:00:00Z`) } },
      include: { category: { select: { name: true } }, branch: { select: { name: true } }, employee: { select: { fullName: true } } },
      orderBy: [{ expenseDate: 'asc' }, { createdAt: 'asc' }],
    });
    const totalAmount = rows.reduce((a, r) => a.add(r.amount), ZERO);
    const group = (key: (r: (typeof rows)[number]) => string) => {
      const m = new Map<string, { n: number; amount: D; tax: D }>();
      for (const r of rows) {
        const k = key(r);
        const c = m.get(k) ?? { n: 0, amount: ZERO, tax: ZERO };
        m.set(k, { n: c.n + 1, amount: c.amount.add(r.amount), tax: c.tax.add(r.taxAmount) });
      }
      return [...m.entries()];
    };
    const cols = (first: string, label: string) => [
      { key: first, label },
      { key: 'count', label: 'Entries', type: 'number' as const },
      { key: 'amount', label: 'Amount', type: 'money' as const },
      { key: 'tax', label: 'GST in it', type: 'money' as const },
      { key: 'share', label: 'Share', type: 'percent' as const },
    ];
    const shape = (k: string) => ([name, v]: [string, { n: number; amount: D; tax: D }]) => ({ [k]: name, count: v.n, amount: money(v.amount), tax: money(v.tax), share: pct(v.amount, totalAmount) });
    return {
      ...this.base('expenses', 'Expenses', p, branches),
      summary: [
        { key: 'count', label: 'Expenses', value: rows.length, type: 'number' },
        { key: 'total', label: 'Total spent (incl. GST)', value: money(totalAmount), type: 'money' },
        { key: 'tax', label: 'GST included', value: money(rows.reduce((a, r) => a.add(r.taxAmount), ZERO)), type: 'money' },
        { key: 'fromCashDrawer', label: 'Paid from cash drawers', value: money(rows.filter((r) => r.cashSessionId).reduce((a, r) => a.add(r.amount), ZERO)), type: 'money' },
      ],
      tables: [
        { key: 'byCategory', title: 'By category', columns: cols('category', 'Category'), rows: group((r) => r.category.name).sort((a, b) => b[1].amount.cmp(a[1].amount)).map(shape('category')) },
        { key: 'byMethod', title: 'By payment method', columns: cols('method', 'Method'), rows: group((r) => r.paymentMethod).sort((a, b) => a[0].localeCompare(b[0])).map(shape('method')) },
        {
          key: 'byDay',
          title: 'By day',
          columns: cols('date', 'Date'),
          rows: group((r) => r.expenseDate.toISOString().slice(0, 10)).sort((a, b) => a[0].localeCompare(b[0])).map(shape('date')),
        },
        capped(
          'rows',
          'All expenses',
          [
            { key: 'date', label: 'Date' },
            { key: 'branch', label: 'Branch' },
            { key: 'category', label: 'Category' },
            { key: 'description', label: 'Description' },
            { key: 'paidTo', label: 'Paid to' },
            { key: 'employee', label: 'Employee' },
            { key: 'method', label: 'Method' },
            { key: 'amount', label: 'Amount', type: 'money' },
            { key: 'tax', label: 'GST', type: 'money' },
          ],
          rows.map((r) => ({ date: r.expenseDate.toISOString().slice(0, 10), branch: r.branch.name, category: r.category.name, description: r.description, paidTo: r.paidTo, employee: r.employee?.fullName ?? null, method: r.paymentMethod, amount: money(r.amount), tax: money(r.taxAmount) })),
        ),
      ],
    };
  }

  /** Estimated profit: net sales − recipe cost of what was sold − wastage − expenses. */
  async profitLoss(actor: AuthPrincipal, q: ReportQuery): Promise<Report> {
    const { p, branches, ids, org } = await this.scope(actor, ['reports.financial'], q);
    const [facts, costs] = await Promise.all([salesFacts(this.prisma, org, ids, p), costFacts(this.prisma, org, ids, p)]);
    const perBranch = rollUp(facts, 'branch');
    const f = total(facts);
    const c = sumCosts(costs);
    const d = derived(f);
    const grossProfit = d.netSales.sub(c.cogs);
    const profit = profitOf(f, c);
    const purchases = await this.prisma.$queryRaw<{ value: unknown }[]>`
      SELECT coalesce(sum(round(gi.quantity * gi.unit_price, 2)), 0) AS value
      FROM goods_receipts g JOIN goods_receipt_items gi ON gi.goods_receipt_id = g.id
      WHERE g.organization_id = ${org}::uuid AND g.branch_id = ANY(${ids}::uuid[]) AND g.received_at >= ${p.gte} AND g.received_at < ${p.lt}`;
    const line = (key: string, label: string, amount: D, base = d.netSales) => ({ key, line: label, amount: money(amount), ofSales: pct(amount, base) });
    return {
      ...this.base('profit-loss', 'Profit and loss (estimated)', p, branches),
      summary: [
        { key: 'netSales', label: 'Net sales (excl. GST)', value: money(d.netSales), type: 'money' },
        { key: 'costOfGoodsSold', label: 'Recipe cost of sales', value: money(c.cogs), type: 'money' },
        { key: 'grossProfit', label: 'Gross profit', value: money(grossProfit), type: 'money' },
        { key: 'grossMargin', label: 'Gross margin', value: pct(grossProfit, d.netSales), type: 'percent' },
        { key: 'wastage', label: 'Wastage', value: money(c.wastage), type: 'money' },
        { key: 'expenses', label: 'Expenses', value: money(c.expenses), type: 'money' },
        { key: 'estimatedProfit', label: 'Estimated profit', value: money(profit), type: 'money' },
        { key: 'profitMargin', label: 'Profit margin', value: pct(profit, d.netSales), type: 'percent' },
        { key: 'gstCollected', label: 'GST collected (owed to government)', value: money(d.netTax), type: 'money' },
        { key: 'purchases', label: 'Stock bought (before GST)', value: money(dec(purchases[0]?.value)), type: 'money' },
      ],
      tables: [
        {
          key: 'statement',
          title: 'Statement',
          columns: [
            { key: 'line', label: '' },
            { key: 'amount', label: 'Amount', type: 'money' },
            { key: 'ofSales', label: '% of sales', type: 'percent' },
          ],
          rows: [
            line('grossSales', 'Gross sales (before discounts)', f.gross),
            line('discounts', 'Less: discounts', f.discounts),
            line('serviceCharge', 'Service charge', f.serviceCharge),
            line('creditNotes', 'Less: credit notes', f.cnTaxable),
            line('netSales', 'Net sales', d.netSales),
            line('costOfGoodsSold', 'Less: recipe cost of sales', c.cogs),
            line('grossProfit', 'Gross profit', grossProfit),
            line('wastage', 'Less: wastage', c.wastage),
            line('expenses', 'Less: expenses', c.expenses),
            line('estimatedProfit', 'Estimated profit', profit),
          ],
        },
        {
          key: 'byBranch',
          title: 'By branch',
          columns: [
            { key: 'branch', label: 'Branch' },
            { key: 'netSales', label: 'Net sales', type: 'money' },
            { key: 'costOfGoodsSold', label: 'Recipe cost', type: 'money' },
            { key: 'wastage', label: 'Wastage', type: 'money' },
            { key: 'expenses', label: 'Expenses', type: 'money' },
            { key: 'estimatedProfit', label: 'Profit', type: 'money' },
            { key: 'profitMargin', label: 'Margin', type: 'percent' },
          ],
          rows: branches.map((b) => {
            const bf = perBranch.get(b.id) ?? emptyFact();
            const bc = costs.get(b.id) ?? emptyCosts();
            const pr = profitOf(bf, bc);
            const ns = derived(bf).netSales;
            return { branchId: b.id, branch: b.name, netSales: money(ns), costOfGoodsSold: money(bc.cogs), wastage: money(bc.wastage), expenses: money(bc.expenses), estimatedProfit: money(pr), profitMargin: pct(pr, ns) };
          }),
        },
      ],
      notes: [
        'An estimate: recipe cost uses the recipes and average stock cost at the time of sale; items without a recipe cost nothing. Purchases are not an expense here (they become stock and count when used or wasted).',
        'Expenses are counted in full including any GST, on the expense date. GST collected from customers is not income.',
      ],
    };
  }

  async branches(actor: AuthPrincipal, q: ReportQuery): Promise<Report> {
    const { p, branches, ids, org } = await this.scope(actor, ['reports.sales'], q);
    const [facts, orders] = await Promise.all([salesFacts(this.prisma, org, ids, p), orderCounts(this.prisma, org, ids, p)]);
    const per = rollUp(facts, 'branch');
    const all = total(facts);
    const netAll = derived(all).netSales;
    const rows = branches
      .map((b) => {
        const f = per.get(b.id) ?? emptyFact();
        const d = derived(f);
        const o = orders.get(b.id) ?? { total: 0, completed: 0, cancelled: 0, pending: 0 };
        return {
          branchId: b.id,
          branch: b.name,
          orders: o.total,
          cancelledOrders: o.cancelled,
          invoices: f.invoices,
          netSales: money(d.netSales),
          netTax: money(d.netTax),
          netBilled: money(d.netBilled),
          averageBill: ratio(f.finalBilled, f.invoices),
          discounts: money(f.discounts),
          netCollected: money(d.netCollected),
          share: pct(d.netSales, netAll),
        };
      })
      .sort((a, b) => dec(b.netSales).cmp(dec(a.netSales)));
    return {
      ...this.base('branches', 'Branch performance', p, branches),
      summary: [
        { key: 'branches', label: 'Branches', value: branches.length, type: 'number' },
        { key: 'netSales', label: 'Net sales (excl. GST)', value: money(netAll), type: 'money' },
        { key: 'netBilled', label: 'Billed incl. GST', value: money(derived(all).netBilled), type: 'money' },
        { key: 'netCollected', label: 'Net collected', value: money(derived(all).netCollected), type: 'money' },
      ],
      tables: [
        {
          key: 'rows',
          title: 'Branches',
          columns: [
            { key: 'branch', label: 'Branch' },
            { key: 'orders', label: 'Orders', type: 'number' },
            { key: 'cancelledOrders', label: 'Cancelled', type: 'number' },
            { key: 'invoices', label: 'Bills', type: 'number' },
            { key: 'netSales', label: 'Net sales', type: 'money' },
            { key: 'netTax', label: 'GST', type: 'money' },
            { key: 'averageBill', label: 'Avg bill', type: 'money' },
            { key: 'discounts', label: 'Discounts', type: 'money' },
            { key: 'netCollected', label: 'Collected', type: 'money' },
            { key: 'share', label: 'Share', type: 'percent' },
          ],
          rows,
        },
      ],
    };
  }

  /**
   * What each staff member did in the period, from the records that name them: orders taken,
   * bills raised, money taken, refunds, discounts, cancellations, cash shifts and attendance.
   */
  async employees(actor: AuthPrincipal, q: ReportQuery): Promise<Report> {
    const { p, branches, ids, org } = await this.scope(actor, ['reports.employee'], q);
    type R = { user_id: string } & Record<string, unknown>;
    const [orders, bills, payments, refunds, discounts, cancelledOrders, cancelledItems, shifts, attendance] = await Promise.all([
      this.prisma.$queryRaw<R[]>`SELECT created_by_id::text AS user_id, count(*)::int AS n FROM orders
        WHERE organization_id = ${org}::uuid AND branch_id = ANY(${ids}::uuid[]) AND created_at >= ${p.gte} AND created_at < ${p.lt} GROUP BY 1`,
      this.prisma.$queryRaw<R[]>`SELECT created_by_id::text AS user_id, count(*)::int AS n, sum(grand_total) AS amount FROM invoices
        WHERE organization_id = ${org}::uuid AND branch_id = ANY(${ids}::uuid[]) AND status = 'FINALIZED' AND invoice_date >= ${p.gte} AND invoice_date < ${p.lt} GROUP BY 1`,
      this.prisma.$queryRaw<R[]>`SELECT received_by_id::text AS user_id, count(*)::int AS n, sum(amount) AS amount FROM payments
        WHERE organization_id = ${org}::uuid AND branch_id = ANY(${ids}::uuid[]) AND status = 'COMPLETED' AND received_at >= ${p.gte} AND received_at < ${p.lt} GROUP BY 1`,
      this.prisma.$queryRaw<R[]>`SELECT processed_by_id::text AS user_id, count(*)::int AS n, sum(amount) AS amount FROM refunds
        WHERE organization_id = ${org}::uuid AND branch_id = ANY(${ids}::uuid[]) AND status = 'COMPLETED' AND created_at >= ${p.gte} AND created_at < ${p.lt} GROUP BY 1`,
      this.prisma.$queryRaw<R[]>`SELECT ad.applied_by_id::text AS user_id, count(*)::int AS n, sum(ad.amount) AS amount FROM applied_discounts ad JOIN orders o ON o.id = ad.order_id
        WHERE o.organization_id = ${org}::uuid AND o.branch_id = ANY(${ids}::uuid[]) AND ad.amount > 0 AND ad.created_at >= ${p.gte} AND ad.created_at < ${p.lt} GROUP BY 1`,
      this.prisma.$queryRaw<R[]>`SELECT cancelled_by_id::text AS user_id, count(*)::int AS n FROM orders
        WHERE organization_id = ${org}::uuid AND branch_id = ANY(${ids}::uuid[]) AND status = 'CANCELLED' AND cancelled_at >= ${p.gte} AND cancelled_at < ${p.lt} AND cancelled_by_id IS NOT NULL GROUP BY 1`,
      this.prisma.$queryRaw<R[]>`SELECT oi.cancelled_by_id::text AS user_id, count(*)::int AS n FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.organization_id = ${org}::uuid AND o.branch_id = ANY(${ids}::uuid[]) AND oi.status = 'CANCELLED' AND oi.cancelled_at >= ${p.gte} AND oi.cancelled_at < ${p.lt} AND oi.cancelled_by_id IS NOT NULL
          AND (o.cancelled_at IS NULL OR oi.cancelled_at < o.cancelled_at) GROUP BY 1`,
      this.prisma.$queryRaw<R[]>`SELECT user_id::text AS user_id, count(*)::int AS n, coalesce(sum(discrepancy), 0) AS difference, count(*) FILTER (WHERE discrepancy < 0)::int AS short FROM cash_sessions
        WHERE organization_id = ${org}::uuid AND branch_id = ANY(${ids}::uuid[]) AND status = 'CLOSED' AND closed_at >= ${p.gte} AND closed_at < ${p.lt} GROUP BY 1`,
      this.prisma.$queryRaw<R[]>`SELECT e.user_id::text AS user_id,
          count(*) FILTER (WHERE a.status = 'PRESENT')::int AS present, count(*) FILTER (WHERE a.status = 'HALF_DAY')::int AS half,
          count(*) FILTER (WHERE a.status = 'ABSENT')::int AS absent, count(*) FILTER (WHERE a.status = 'LEAVE')::int AS leave,
          coalesce(sum(round(extract(epoch FROM (a.clock_out_at - a.clock_in_at)) / 3600, 2)) FILTER (WHERE a.clock_out_at IS NOT NULL), 0) AS hours
        FROM attendance a JOIN employees e ON e.id = a.employee_id
        WHERE a.organization_id = ${org}::uuid AND a.branch_id = ANY(${ids}::uuid[]) AND e.user_id IS NOT NULL AND a.work_date >= ${p.from}::date AND a.work_date <= ${p.to}::date GROUP BY 1`,
    ]);
    const sets = { orders, bills, payments, refunds, discounts, cancelledOrders, cancelledItems, shifts, attendance };
    const userIds = [...new Set(Object.values(sets).flatMap((xs) => xs.map((x) => x.user_id)))];
    const users = await this.prisma.user.findMany({ where: { id: { in: userIds }, organizationId: org }, select: { id: true, fullName: true, employee: { select: { employeeCode: true } } } });
    const of = (xs: R[], id: string) => xs.find((x) => x.user_id === id);
    const n = (x: R | undefined, k = 'n') => (x ? Number(x[k]) : 0);
    const rows = users
      .map((u) => {
        const a = of(attendance, u.id);
        return {
          userId: u.id,
          name: u.fullName,
          employeeCode: u.employee?.employeeCode ?? null,
          ordersTaken: n(of(orders, u.id)),
          billsRaised: n(of(bills, u.id)),
          billedAmount: money(dec(of(bills, u.id)?.amount)),
          paymentsTaken: n(of(payments, u.id)),
          amountCollected: money(dec(of(payments, u.id)?.amount)),
          refundsPaid: n(of(refunds, u.id)),
          refundAmount: money(dec(of(refunds, u.id)?.amount)),
          discountsGiven: n(of(discounts, u.id)),
          discountAmount: money(dec(of(discounts, u.id)?.amount)),
          ordersCancelled: n(of(cancelledOrders, u.id)),
          itemsCancelled: n(of(cancelledItems, u.id)),
          shiftsClosed: n(of(shifts, u.id)),
          shiftsShort: n(of(shifts, u.id), 'short'),
          cashDifference: money(dec(of(shifts, u.id)?.difference)),
          daysPresent: n(a, 'present'),
          halfDays: n(a, 'half'),
          daysAbsent: n(a, 'absent'),
          daysOnLeave: n(a, 'leave'),
          hoursWorked: money(dec(a?.hours)),
        };
      })
      .sort((x, y) => dec(y.amountCollected).cmp(dec(x.amountCollected)) || x.name.localeCompare(y.name));
    return {
      ...this.base('employees', 'Employee performance', p, branches),
      summary: [{ key: 'staff', label: 'Staff with activity', value: rows.length, type: 'number' }],
      tables: [
        {
          key: 'rows',
          title: 'Staff',
          columns: [
            { key: 'name', label: 'Name' },
            { key: 'ordersTaken', label: 'Orders', type: 'number' },
            { key: 'billsRaised', label: 'Bills', type: 'number' },
            { key: 'billedAmount', label: 'Billed', type: 'money' },
            { key: 'amountCollected', label: 'Collected', type: 'money' },
            { key: 'refundAmount', label: 'Refunds', type: 'money' },
            { key: 'discountAmount', label: 'Discounts', type: 'money' },
            { key: 'ordersCancelled', label: 'Orders cxl', type: 'number' },
            { key: 'itemsCancelled', label: 'Items cxl', type: 'number' },
            { key: 'shiftsClosed', label: 'Shifts', type: 'number' },
            { key: 'cashDifference', label: 'Cash diff', type: 'money' },
            { key: 'daysPresent', label: 'Days', type: 'number' },
            { key: 'hoursWorked', label: 'Hours', type: 'number' },
          ],
          rows,
        },
      ],
      notes: ['Each figure counts what the person did themselves (who took the order, raised the bill, took the payment). Cash diff is the sum of their closed shifts’ differences (negative = short).'],
    };
  }
}
