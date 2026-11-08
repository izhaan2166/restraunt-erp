import { Prisma } from '@prisma/client';

export type D = Prisma.Decimal;
export const Dec = Prisma.Decimal;
export const ZERO = new Dec(0);

export type Cell = string | number | null;
export type Row = Record<string, Cell>;
export type ColumnType = 'text' | 'money' | 'qty' | 'number' | 'percent';

export interface Column {
  key: string;
  label: string;
  type?: ColumnType;
}

export interface Table {
  key: string;
  title: string;
  columns: Column[];
  rows: Row[];
  /** True when the table was cut at MAX_ROWS (only lists of individual records can be). */
  truncated?: boolean;
}

export interface SummaryItem {
  key: string;
  label: string;
  value: Cell;
  type?: ColumnType;
}

/**
 * Every report has the same shape so that one CSV writer and one PDF writer serve all of them:
 * a title, the period and branches it covers, a few headline figures and one or more tables.
 */
export interface Report {
  key: string;
  title: string;
  from: string;
  to: string;
  branches: { id: string; name: string }[];
  summary: SummaryItem[];
  tables: Table[];
  notes?: string[];
}

export const MAX_ROWS = 5000;

/** Money as a string with 2 decimals; never "-0.00". */
export const money = (d: D | number | string | null | undefined): string => {
  const v = new Dec(d ?? 0).toDecimalPlaces(2, Dec.ROUND_HALF_UP);
  return v.isZero() ? '0.00' : v.toFixed(2);
};
/** Quantity without trailing zeros (up to 3 decimals). */
export const qty = (d: D | number | string | null | undefined): string => {
  const v = new Dec(d ?? 0).toDecimalPlaces(3, Dec.ROUND_HALF_UP);
  return v.isZero() ? '0' : v.toString();
};
export const dec = (v: unknown): D => (v === null || v === undefined ? ZERO : new Dec(v as Prisma.Decimal.Value));
/** a / b as a percentage with 2 decimals, or null when b is 0. */
export const pct = (a: D, b: D): string | null => (b.isZero() ? null : money(a.mul(100).div(b)));
export const ratio = (a: D, n: number): string => (n === 0 ? '0.00' : money(a.div(n)));

/** The JSON form returned by the API: summary as an object, tables keyed by name. */
export function toJson(r: Report) {
  return {
    report: r.key,
    title: r.title,
    from: r.from,
    to: r.to,
    branches: r.branches,
    summary: Object.fromEntries(r.summary.map((s) => [s.key, s.value])),
    ...Object.fromEntries(r.tables.map((t) => [t.key, t.rows])),
    ...(r.tables.some((t) => t.truncated) ? { truncated: r.tables.filter((t) => t.truncated).map((t) => t.key) } : {}),
    ...(r.notes?.length ? { notes: r.notes } : {}),
  };
}

/** Wraps a list query result: keeps at most MAX_ROWS rows. */
export function capped(key: string, title: string, columns: Column[], rows: Row[]): Table {
  return rows.length > MAX_ROWS ? { key, title, columns, rows: rows.slice(0, MAX_ROWS), truncated: true } : { key, title, columns, rows };
}

/** "2026-11-08T14:05:00Z" → "2026-11-08 19:35" (India time), for lists. */
export function istStamp(at: Date | null | undefined): string | null {
  if (!at) return null;
  return new Date(at.getTime() + 5.5 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
}
