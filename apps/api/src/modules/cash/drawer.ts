import { CashMovementType, Prisma } from '@prisma/client';
import { Errors } from '../../common/errors/app-error';

type Tx = Prisma.TransactionClient;
type D = Prisma.Decimal;
const Dec = Prisma.Decimal;

export interface LockedSession {
  id: string;
  organization_id: string;
  branch_id: string;
  user_id: string;
  status: 'OPEN' | 'CLOSED';
}

/** The user's open cash shift in the branch, row-locked so drawer entries are applied one at a time. */
export async function lockOpenSession(tx: Tx, branchId: string, userId: string): Promise<LockedSession | null> {
  const rows = await tx.$queryRaw<LockedSession[]>`
    SELECT id, organization_id, branch_id, user_id, status FROM cash_sessions
    WHERE branch_id = ${branchId}::uuid AND user_id = ${userId}::uuid AND status = 'OPEN' FOR UPDATE`;
  return rows[0] ?? null;
}

export async function lockSession(tx: Tx, organizationId: string, id: string): Promise<LockedSession | null> {
  const rows = await tx.$queryRaw<LockedSession[]>`
    SELECT id, organization_id, branch_id, user_id, status FROM cash_sessions
    WHERE id = ${id}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`;
  return rows[0] ?? null;
}

/** Cash that should be in the drawer now: the sum of its entries (opening float included). */
export async function drawerBalance(tx: Tx, sessionId: string): Promise<D> {
  const agg = await tx.cashMovement.aggregate({ where: { cashSessionId: sessionId }, _sum: { amount: true } });
  return agg._sum.amount ?? new Dec(0);
}

export async function cashRequiresShift(tx: Tx, branchId: string): Promise<boolean> {
  const s = await tx.branchSettings.findUnique({ where: { branchId }, select: { cashRequiresShift: true } });
  return s?.cashRequiresShift ?? true;
}

/**
 * Adds one entry to an open drawer (call with the session locked). Money out can never take the
 * drawer below zero: there is no cash to hand over.
 */
export async function postCash(
  tx: Tx,
  session: LockedSession,
  e: { type: CashMovementType; amount: D; referenceType?: string; referenceId?: string; note?: string | null; userId: string },
) {
  if (session.status !== 'OPEN') throw Errors.conflict('SHIFT_CLOSED', 'This cash shift is closed');
  if (e.amount.lt(0)) {
    const inDrawer = await drawerBalance(tx, session.id);
    if (inDrawer.add(e.amount).lt(0)) {
      throw Errors.conflict('INSUFFICIENT_CASH', `Only ₹${inDrawer.toFixed(2)} is in this drawer`, { inDrawer: inDrawer.toFixed(2), requested: e.amount.neg().toFixed(2) });
    }
  }
  return tx.cashMovement.create({
    data: {
      organizationId: session.organization_id,
      branchId: session.branch_id,
      cashSessionId: session.id,
      type: e.type,
      amount: e.amount,
      referenceType: e.referenceType ?? null,
      referenceId: e.referenceId ?? null,
      note: e.note ?? null,
      createdById: e.userId,
    },
  });
}

/**
 * The drawer a cash payment goes into: the receiver's open shift. With no shift open, the branch
 * either refuses cash (default) or records the payment without a drawer.
 */
export async function drawerForCash(tx: Tx, branchId: string, userIds: string[]): Promise<LockedSession | null> {
  for (const userId of [...new Set(userIds)]) {
    const s = await lockOpenSession(tx, branchId, userId);
    if (s) return s;
  }
  if (await cashRequiresShift(tx, branchId)) {
    throw Errors.conflict('NO_OPEN_SHIFT', 'Open a cash shift (count your drawer) before taking or giving back cash');
  }
  return null;
}
