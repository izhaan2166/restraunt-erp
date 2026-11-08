import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthPrincipal } from '../auth/principal';
import { DashboardQuery } from './dto/reports.dto';
import { costFacts, derived, emptyFact, netOf, orderCounts, productSales, rollUp, salesFacts, sumCosts, total } from './facts';
import { dec, money, qty, ratio } from './report';
import { holdsEverywhere, presetPeriod, reportBranches } from './scope';

/**
 * The live dashboard: one call, every figure computed from the records for the chosen range.
 * Screens refresh it when `order.*`, `payment.completed` or `inventory.low_stock` events arrive.
 * Expenses and profit are shown only to people who may see financial reports for every branch
 * on the dashboard; low stock only for branches where they may see inventory.
 */
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async get(actor: AuthPrincipal, q: DashboardQuery) {
    const range = q.range ?? 'today';
    const p = presetPeriod(range, q.from, q.to);
    const branches = await reportBranches(this.prisma, actor, ['dashboard.read'], q.branchId);
    const ids = branches.map((b) => b.id);
    const org = actor.organizationId;
    const financial = holdsEverywhere(actor, 'reports.financial', branches);
    const stockBranches = ids.filter((b) => actor.permissions.has('inventory.read', b));

    const [facts, orders, costs, products, methods, refundMethods, recent, lowStock] = await Promise.all([
      salesFacts(this.prisma, org, ids, p),
      orderCounts(this.prisma, org, ids, p),
      financial ? costFacts(this.prisma, org, ids, p) : Promise.resolve(null),
      productSales(this.prisma, org, ids, p),
      this.prisma.$queryRaw<{ method: string; n: number; amount: unknown }[]>`
        SELECT method::text AS method, count(*)::int AS n, sum(amount) AS amount FROM payments
        WHERE organization_id = ${org}::uuid AND branch_id = ANY(${ids}::uuid[]) AND status = 'COMPLETED' AND received_at >= ${p.gte} AND received_at < ${p.lt}
        GROUP BY 1 ORDER BY 3 DESC`,
      this.prisma.$queryRaw<{ method: string; amount: unknown }[]>`
        SELECT method::text AS method, sum(amount) AS amount FROM refunds
        WHERE organization_id = ${org}::uuid AND branch_id = ANY(${ids}::uuid[]) AND status = 'COMPLETED' AND created_at >= ${p.gte} AND created_at < ${p.lt}
        GROUP BY 1`,
      this.prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT * FROM (
          SELECT 'PAYMENT' AS kind, y.id::text AS id, y.received_at AS at, y.method::text AS method, y.amount, y.status::text AS status, u.full_name AS by_name, b.name AS branch,
            (SELECT i.invoice_number FROM payment_allocations pa JOIN invoices i ON i.id = pa.invoice_id WHERE pa.payment_id = y.id ORDER BY pa.created_at LIMIT 1) AS invoice_number
          FROM payments y JOIN users u ON u.id = y.received_by_id JOIN branches b ON b.id = y.branch_id
          WHERE y.organization_id = ${org}::uuid AND y.branch_id = ANY(${ids}::uuid[]) AND y.received_at >= ${p.gte} AND y.received_at < ${p.lt}
          UNION ALL
          SELECT 'REFUND', r.id::text, r.created_at, r.method::text, r.amount, r.status::text, u.full_name, b.name, i.invoice_number
          FROM refunds r JOIN users u ON u.id = r.processed_by_id JOIN branches b ON b.id = r.branch_id JOIN invoices i ON i.id = r.invoice_id
          WHERE r.organization_id = ${org}::uuid AND r.branch_id = ANY(${ids}::uuid[]) AND r.created_at >= ${p.gte} AND r.created_at < ${p.lt}
        ) t ORDER BY at DESC LIMIT 10`,
      stockBranches.length
        ? this.prisma.$queryRaw<Record<string, unknown>[]>`
            SELECT g.id::text AS ingredient_id, g.name, u.code AS unit, b.id::text AS branch_id, b.name AS branch, ib.quantity, ib.minimum_level
            FROM inventory_balances ib JOIN ingredients g ON g.id = ib.ingredient_id JOIN units u ON u.id = g.base_unit_id JOIN branches b ON b.id = ib.branch_id
            WHERE ib.organization_id = ${org}::uuid AND ib.branch_id = ANY(${stockBranches}::uuid[]) AND g.deleted_at IS NULL AND g.is_active
              AND ib.minimum_level > 0 AND ib.quantity < ib.minimum_level
            ORDER BY (ib.quantity / ib.minimum_level), g.name LIMIT 20`
        : Promise.resolve(null),
    ]);

    const f = total(facts);
    const d = derived(f);
    const o = [...orders.values()].reduce((a, x) => ({ total: a.total + x.total, completed: a.completed + x.completed, cancelled: a.cancelled + x.cancelled, pending: a.pending + x.pending }), { total: 0, completed: 0, cancelled: 0, pending: 0 });
    const c = costs ? sumCosts(costs) : null;
    const perBranch = rollUp(facts, 'branch');

    return {
      range,
      from: p.from,
      to: p.to,
      generatedAt: new Date().toISOString(),
      branches,
      sales: {
        /** What customers were charged, GST included, after credit notes. */
        totalSales: money(d.netBilled),
        grossRevenue: money(f.gross),
        discounts: money(f.discounts),
        netRevenue: money(d.netSales),
        tax: money(d.netTax),
        averageOrderValue: ratio(f.finalBilled, f.invoices),
        bills: f.invoices,
        collected: money(f.collected),
        refunded: money(f.refunded),
        netCollected: money(d.netCollected),
      },
      orders: o,
      expenses: c ? money(c.expenses) : null,
      estimatedProfit: c ? money(d.netSales.sub(c.cogs).sub(c.wastage).sub(c.expenses)) : null,
      paymentMethods: methods.map((m) => {
        const r = dec(refundMethods.find((x) => x.method === m.method)?.amount);
        return { method: m.method, payments: m.n, amount: money(dec(m.amount)), refunded: money(r), net: money(dec(m.amount).sub(r)) };
      }),
      bestSellers: products.lines
        .map((l) => ({ l, n: netOf(l) }))
        .filter((x) => x.n.quantity.gt(0))
        .sort((a, b) => b.n.quantity.cmp(a.n.quantity) || b.n.sales.cmp(a.n.sales))
        .slice(0, 5)
        .map(({ l, n }) => ({ productId: l.productId, name: l.name, category: l.category, quantity: qty(n.quantity), netSales: money(n.sales) })),
      lowStock: lowStock
        ? lowStock.map((r) => ({ ingredientId: r.ingredient_id, name: r.name, unit: r.unit, branchId: r.branch_id, branch: r.branch, quantity: qty(dec(r.quantity)), minimumLevel: qty(dec(r.minimum_level)) }))
        : null,
      recentTransactions: recent.map((r) => ({
        type: r.kind,
        id: r.id,
        at: (r.at as Date).toISOString(),
        method: r.method,
        amount: money(dec(r.amount)),
        status: r.status === 'VOIDED' ? 'REJECTED' : r.status,
        invoiceNumber: r.invoice_number ?? null,
        by: r.by_name,
        branch: r.branch,
      })),
      branchPerformance: branches
        .map((b) => {
          const bf = perBranch.get(b.id) ?? emptyFact();
          const bo = orders.get(b.id);
          return { branchId: b.id, branch: b.name, orders: bo?.total ?? 0, bills: bf.invoices, netRevenue: money(derived(bf).netSales), totalSales: money(derived(bf).netBilled), averageOrderValue: ratio(bf.finalBilled, bf.invoices) };
        })
        .sort((a, b) => dec(b.netRevenue).cmp(dec(a.netRevenue))),
      // Kept explicit so a screen can show "–" rather than 0 when the figure is hidden.
      hidden: [...(c ? [] : ['expenses', 'estimatedProfit']), ...(lowStock ? [] : ['lowStock'])],
    };
  }
}

