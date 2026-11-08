import { Errors } from './errors/app-error';
import { istDay } from '../modules/sequences/sequences';

const IST_OFFSET_MS = 5.5 * 3600_000;
const DAY_MS = 86_400_000;
export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar date ("2026-11-08") as the midnight-UTC value Postgres `date` columns use. */
export function dateOnly(s: string): Date {
  const d = new Date(`${s.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw Errors.badRequest('INVALID_DATE', `${s} is not a valid date`);
  return d;
}

/** Today's business date in India, as a `date` value. */
export function todayIst(): Date {
  const d = istDay();
  return new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00Z`);
}

/** The business date in India of a moment. */
export function istDateOf(at: Date): Date {
  const d = new Date(at.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Timestamps falling on the business dates `from`..`to` (inclusive, India time). Either end may be
 * left open.
 */
export function istRange(from?: string, to?: string): { gte?: Date; lt?: Date } | undefined {
  if (!from && !to) return undefined;
  const r: { gte?: Date; lt?: Date } = {};
  if (from) r.gte = new Date(dateOnly(from).getTime() - IST_OFFSET_MS);
  if (to) r.lt = new Date(dateOnly(to).getTime() + DAY_MS - IST_OFFSET_MS);
  if (r.gte && r.lt && r.gte >= r.lt) throw Errors.badRequest('INVALID_RANGE', '"from" must be on or before "to"');
  return r;
}

/** `date`-column filter for business dates `from`..`to` (inclusive). */
export function dateRange(from?: string, to?: string): { gte?: Date; lte?: Date } | undefined {
  if (!from && !to) return undefined;
  const r = { gte: from ? dateOnly(from) : undefined, lte: to ? dateOnly(to) : undefined };
  if (r.gte && r.lte && r.gte > r.lte) throw Errors.badRequest('INVALID_RANGE', '"from" must be on or before "to"');
  return r;
}
