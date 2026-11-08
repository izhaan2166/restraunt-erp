import { dateOnly, istRange, todayIst } from '../../common/dates';
import { Errors } from '../../common/errors/app-error';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuthPrincipal } from '../auth/principal';

const DAY_MS = 86_400_000;
/** Reports may span up to five years (annual comparisons); longer ranges are refused. */
export const MAX_REPORT_DAYS = 1827;

export interface Period {
  from: string;
  to: string;
  /** Timestamp bounds of the India business dates from..to: gte ≤ t < lt. */
  gte: Date;
  lt: Date;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function period(from: string, to: string): Period {
  const r = istRange(from, to)!;
  const days = (dateOnly(to).getTime() - dateOnly(from).getTime()) / DAY_MS + 1;
  if (days > MAX_REPORT_DAYS) throw Errors.badRequest('RANGE_TOO_LONG', `Ask for at most ${MAX_REPORT_DAYS} days (five years) at a time`);
  return { from, to, gte: r.gte!, lt: r.lt! };
}

export type Preset = 'today' | 'yesterday' | 'this_week' | 'this_month' | 'custom';

/** The dashboard's ranges. Weeks start on Monday; "this week/month" run up to today. */
export function presetPeriod(range: Preset, from?: string, to?: string, today: Date = todayIst()): Period {
  const t = today.getTime();
  switch (range) {
    case 'today':
      return period(iso(today), iso(today));
    case 'yesterday':
      return period(iso(new Date(t - DAY_MS)), iso(new Date(t - DAY_MS)));
    case 'this_week': {
      const back = (today.getUTCDay() + 6) % 7;
      return period(iso(new Date(t - back * DAY_MS)), iso(today));
    }
    case 'this_month':
      return period(`${iso(today).slice(0, 8)}01`, iso(today));
    case 'custom':
      if (!from || !to) throw Errors.badRequest('RANGE_REQUIRED', 'A custom range needs "from" and "to"');
      return period(from, to);
  }
}

export interface BranchRef {
  id: string;
  name: string;
}

/**
 * The branches a report covers. With `branchId`, just that branch (404 if the caller has no role
 * there, 403 if none of `permissions` is held there). Without, every branch where the caller holds
 * one of `permissions`. A permission list means "any of these".
 */
export async function reportBranches(prisma: PrismaService, actor: AuthPrincipal, permissions: string[], branchId?: string): Promise<BranchRef[]> {
  if (branchId) {
    const access = actor.permissions.accessibleBranches();
    const b = await prisma.branch.findFirst({ where: { id: branchId, organizationId: actor.organizationId, deletedAt: null }, select: { id: true, name: true } });
    if (!b || (access !== 'ALL' && !access.includes(b.id))) throw Errors.notFound('Branch');
    if (!permissions.some((p) => actor.permissions.has(p, b.id))) {
      throw Errors.forbidden('MISSING_PERMISSION', 'You do not have permission to see this report for that branch', { missing: permissions, branchId });
    }
    return [b];
  }
  const ids = new Set<string>();
  let all = false;
  for (const p of permissions) {
    const where = actor.permissions.branchesWith(p);
    if (where === 'ALL') all = true;
    else where.forEach((id) => ids.add(id));
  }
  const rows = await prisma.branch.findMany({
    where: { organizationId: actor.organizationId, deletedAt: null, ...(all ? {} : { id: { in: [...ids] } }) },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  if (!rows.length) throw Errors.forbidden('MISSING_PERMISSION', 'You do not have permission to see this report', { missing: permissions });
  return rows;
}

/** True when `permission` is held in every one of the branches. */
export const holdsEverywhere = (actor: AuthPrincipal, permission: string, branches: BranchRef[]) => branches.every((b) => actor.permissions.has(permission, b.id));
