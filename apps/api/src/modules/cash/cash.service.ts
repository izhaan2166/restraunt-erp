import { Injectable } from '@nestjs/common';
import { CashMovementType, CashSession, PaymentMethod, Prisma } from '@prisma/client';
import { requireInBranch } from '../../common/auth/branch-access';
import { istRange } from '../../common/dates';
import { Paginated } from '../../common/dto/pagination';
import { Errors } from '../../common/errors/app-error';
import type { RequestMeta } from '../../common/http/request-meta';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthPrincipal } from '../auth/principal';
import { CashMovementDto, CloseShiftDto, ListShiftsQuery, OpenShiftDto, ShiftSummaryQuery } from './dto/cash.dto';
import { LockedSession, drawerBalance, lockSession, postCash } from './drawer';

type Tx = Prisma.TransactionClient;
type D = Prisma.Decimal;
const Dec = Prisma.Decimal;
const ZERO = new Dec(0);
/** Money out of the drawer as a positive amount (never "-0"). */
const outflow = (d: D) => (d.isZero() ? ZERO : d.neg());

const CASHIER = { select: { id: true, fullName: true, email: true } } as const;

@Injectable()
export class CashService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Starts a cashier's shift with the cash counted into the drawer. One open shift per cashier per branch. */
  async open(actor: AuthPrincipal, dto: OpenShiftDto, meta: RequestMeta) {
    const id = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cash_open:${dto.branchId}:${actor.userId}`}))`;
      const already = await tx.cashSession.findFirst({ where: { branchId: dto.branchId, userId: actor.userId, status: 'OPEN' } });
      if (already) throw Errors.conflict('SHIFT_ALREADY_OPEN', 'You already have an open cash shift in this branch; close it first', { cashSessionId: already.id });
      const openingBalance = new Dec(dto.openingBalance);
      const s = await tx.cashSession.create({
        data: { organizationId: actor.organizationId, branchId: dto.branchId, userId: actor.userId, terminal: dto.terminal?.trim() || null, openingBalance },
      });
      if (openingBalance.gt(0)) {
        await postCash(tx, this.locked(s), { type: 'OPENING_FLOAT', amount: openingBalance, note: 'Opening float', userId: actor.userId });
      }
      await this.log(tx, actor, s.branchId, 'shift.opened', s.id, undefined, { openingBalance, terminal: s.terminal }, meta);
      return s.id;
    });
    return this.detail(id);
  }

  /** The caller's open shift in the branch, or null. */
  async current(actor: AuthPrincipal, branchId: string) {
    const s = await this.prisma.cashSession.findFirst({ where: { branchId, userId: actor.userId, status: 'OPEN' }, select: { id: true } });
    return s ? this.detail(s.id) : null;
  }

  async list(actor: AuthPrincipal, q: ListShiftsQuery) {
    const where: Prisma.CashSessionWhereInput = {
      organizationId: actor.organizationId,
      branchId: q.branchId,
      status: q.status,
      userId: q.userId,
      openedAt: istRange(q.from, q.to),
    };
    const [rows, total] = await Promise.all([
      this.prisma.cashSession.findMany({ where, include: { user: CASHIER }, orderBy: { openedAt: q.order }, skip: q.skip, take: q.pageSize }),
      this.prisma.cashSession.count({ where }),
    ]);
    const open = rows.filter((r) => r.status === 'OPEN').map((r) => r.id);
    const live = open.length
      ? await this.prisma.cashMovement.groupBy({ by: ['cashSessionId'], where: { cashSessionId: { in: open } }, _sum: { amount: true } })
      : [];
    return new Paginated(
      rows.map((r) => ({ ...r, expectedCash: r.expectedCash ?? live.find((l) => l.cashSessionId === r.id)?._sum.amount ?? ZERO })),
      total,
      q,
    );
  }

  async get(actor: AuthPrincipal, id: string) {
    const s = await this.prisma.cashSession.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!s) throw Errors.notFound('Cash shift');
    this.assertCanSee(actor, s);
    return this.detail(id);
  }

  /** Change added to or cash taken out of a drawer, with a reason. */
  async movement(actor: AuthPrincipal, id: string, dto: CashMovementDto, meta: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      const s = await this.lockOrThrow(tx, actor, id);
      if (s.user_id !== actor.userId) requireInBranch(actor, s.branch_id, ['cash.movement', 'shifts.read'], 'Cash shift');
      const amount = new Dec(dto.amount);
      if (amount.lte(0)) throw Errors.badRequest('INVALID_AMOUNT', 'amount must be greater than 0');
      const m = await postCash(tx, s, { type: dto.type, amount: dto.type === 'CASH_IN' ? amount : amount.neg(), note: dto.reason.trim(), userId: actor.userId });
      await this.log(tx, actor, s.branch_id, dto.type === 'CASH_IN' ? 'shift.cash_in' : 'shift.cash_out', id, undefined, { movementId: m.id, amount, reason: m.note }, meta);
    });
    return this.detail(id);
  }

  /**
   * Closes a shift: the counted cash is compared with what the drawer should hold. Any difference
   * needs an explanation. The closed record is final.
   */
  async close(actor: AuthPrincipal, id: string, dto: CloseShiftDto, meta: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      const s = await this.lockOrThrow(tx, actor, id);
      if (s.user_id !== actor.userId) requireInBranch(actor, s.branch_id, ['shifts.close', 'shifts.read'], 'Cash shift');
      const expectedCash = await drawerBalance(tx, id);
      const actualCash = new Dec(dto.actualCash);
      const discrepancy = actualCash.sub(expectedCash);
      const notes = dto.notes?.trim() || null;
      if (!discrepancy.isZero() && (!notes || notes.length < 3)) {
        throw Errors.badRequest('DISCREPANCY_NOTE_REQUIRED', `The drawer is ₹${discrepancy.abs().toFixed(2)} ${discrepancy.lt(0) ? 'short' : 'over'}; add a note explaining it`, {
          expectedCash: expectedCash.toFixed(2),
          discrepancy: discrepancy.toFixed(2),
        });
      }
      await tx.cashSession.update({
        where: { id },
        data: { status: 'CLOSED', expectedCash, actualCash, discrepancy, closingNotes: notes, closedById: actor.userId, closedAt: new Date() },
      });
      await this.log(tx, actor, s.branch_id, 'shift.closed', id, { status: 'OPEN' }, { status: 'CLOSED', expectedCash, actualCash, discrepancy, notes }, meta);
    });
    return this.report(actor, id);
  }

  /** Everything that happened in one shift: drawer totals, takings by payment method, refunds and entries. */
  async report(actor: AuthPrincipal, id: string) {
    const s = await this.prisma.cashSession.findFirst({ where: { id, organizationId: actor.organizationId }, include: { user: CASHIER } });
    if (!s) throw Errors.notFound('Cash shift');
    this.assertCanSee(actor, s);
    const movements = await this.prisma.cashMovement.findMany({ where: { cashSessionId: id }, orderBy: { createdAt: 'asc' } });
    const sum = (t: CashMovementType) => movements.filter((m) => m.type === t).reduce((a, m) => a.add(m.amount), ZERO);
    const count = (t: CashMovementType) => movements.filter((m) => m.type === t).length;
    const expected = movements.reduce((a, m) => a.add(m.amount), ZERO);
    const window = { gte: s.openedAt, ...(s.closedAt ? { lte: s.closedAt } : {}) };
    const [payments, refunds] = await Promise.all([
      this.prisma.payment.groupBy({ by: ['method'], where: { branchId: s.branchId, receivedById: s.userId, status: 'COMPLETED', receivedAt: window }, _sum: { amount: true }, _count: true }),
      this.prisma.refund.groupBy({ by: ['method'], where: { branchId: s.branchId, processedById: s.userId, status: 'COMPLETED', createdAt: window }, _sum: { amount: true }, _count: true }),
    ]);
    const byMethod = (rows: { method: PaymentMethod; _sum: { amount: D | null }; _count: number }[]) =>
      rows.map((r) => ({ method: r.method, count: r._count, amount: r._sum.amount ?? ZERO })).sort((a, b) => a.method.localeCompare(b.method));
    const closer = s.closedById ? await this.prisma.user.findUnique({ where: { id: s.closedById }, select: { id: true, fullName: true } }) : null;
    return {
      id: s.id,
      branchId: s.branchId,
      cashier: s.user,
      terminal: s.terminal,
      status: s.status,
      openedAt: s.openedAt,
      closedAt: s.closedAt,
      closedBy: closer,
      cash: {
        openingFloat: sum('OPENING_FLOAT'),
        cashSales: sum('CASH_SALE'),
        cashRefunds: outflow(sum('CASH_REFUND')),
        cashIn: sum('CASH_IN'),
        cashOut: outflow(sum('CASH_OUT')),
        expenses: outflow(sum('EXPENSE')),
        expected: s.expectedCash ?? expected,
        actual: s.actualCash,
        discrepancy: s.discrepancy,
        notes: s.closingNotes,
      },
      counts: { cashSales: count('CASH_SALE'), cashRefunds: count('CASH_REFUND'), cashIn: count('CASH_IN'), cashOut: count('CASH_OUT'), expenses: count('EXPENSE') },
      paymentsByMethod: byMethod(payments),
      refundsByMethod: byMethod(refunds),
      totalCollected: payments.reduce((a, p) => a.add(p._sum.amount ?? ZERO), ZERO),
      movements,
    };
  }

  /** Per cashier, over a date range: shifts, cash handled and how far their drawers were off. */
  async summary(actor: AuthPrincipal, q: ShiftSummaryQuery) {
    const where: Prisma.CashSessionWhereInput = { organizationId: actor.organizationId, branchId: q.branchId, openedAt: istRange(q.from, q.to) };
    const sessions = await this.prisma.cashSession.findMany({ where, include: { user: CASHIER } });
    const ids = sessions.map((s) => s.id);
    const moves = ids.length
      ? await this.prisma.cashMovement.groupBy({ by: ['cashSessionId', 'type'], where: { cashSessionId: { in: ids } }, _sum: { amount: true } })
      : [];
    const out = new Map<string, { cashier: (typeof sessions)[number]['user']; shifts: number; openShifts: number; cashSales: D; cashRefunds: D; cashIn: D; cashOut: D; expenses: D; shortages: D; overages: D; netDiscrepancy: D }>();
    for (const s of sessions) {
      const row = out.get(s.userId) ?? { cashier: s.user, shifts: 0, openShifts: 0, cashSales: ZERO, cashRefunds: ZERO, cashIn: ZERO, cashOut: ZERO, expenses: ZERO, shortages: ZERO, overages: ZERO, netDiscrepancy: ZERO };
      row.shifts += 1;
      if (s.status === 'OPEN') row.openShifts += 1;
      const m = (t: CashMovementType) => moves.find((x) => x.cashSessionId === s.id && x.type === t)?._sum.amount ?? ZERO;
      row.cashSales = row.cashSales.add(m('CASH_SALE'));
      row.cashRefunds = row.cashRefunds.add(outflow(m('CASH_REFUND')));
      row.cashIn = row.cashIn.add(m('CASH_IN'));
      row.cashOut = row.cashOut.add(outflow(m('CASH_OUT')));
      row.expenses = row.expenses.add(outflow(m('EXPENSE')));
      const d = s.discrepancy ?? ZERO;
      if (d.lt(0)) row.shortages = row.shortages.add(d.neg());
      if (d.gt(0)) row.overages = row.overages.add(d);
      row.netDiscrepancy = row.netDiscrepancy.add(d);
      out.set(s.userId, row);
    }
    return [...out.values()].sort((a, b) => a.cashier.fullName.localeCompare(b.cashier.fullName));
  }

  // ───────────── Helpers ─────────────

  private async detail(id: string) {
    const s = await this.prisma.cashSession.findUniqueOrThrow({ where: { id }, include: { user: CASHIER } });
    const expectedCash = s.expectedCash ?? (await drawerBalance(this.prisma, id));
    return { ...s, expectedCash };
  }

  /** Cashiers see their own shifts; anyone else needs `shifts.read` in the branch. */
  private assertCanSee(actor: AuthPrincipal, s: Pick<CashSession, 'userId' | 'branchId'>) {
    if (s.userId !== actor.userId) requireInBranch(actor, s.branchId, ['shifts.read'], 'Cash shift');
  }

  private async lockOrThrow(tx: Tx, actor: AuthPrincipal, id: string) {
    const s = await lockSession(tx, actor.organizationId, id);
    if (!s) throw Errors.notFound('Cash shift');
    if (s.user_id !== actor.userId) requireInBranch(actor, s.branch_id, ['shifts.read'], 'Cash shift');
    if (s.status !== 'OPEN') throw Errors.conflict('SHIFT_CLOSED', 'This cash shift is already closed');
    return s;
  }

  private locked(s: CashSession): LockedSession {
    return { id: s.id, organization_id: s.organizationId, branch_id: s.branchId, user_id: s.userId, status: s.status };
  }

  private log(tx: Tx, actor: AuthPrincipal, branchId: string, action: string, id: string, before: unknown, after: unknown, meta: RequestMeta) {
    return this.audit.record({ organizationId: actor.organizationId, branchId, actorUserId: actor.userId, action, entityType: 'cash_session', entityId: id, before, after, meta }, tx);
  }
}
