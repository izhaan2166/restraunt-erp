/**
 * Display helpers only. Amounts arrive from the API as exact decimal strings and are never added,
 * multiplied or rounded here: the server is the single place where money is calculated.
 */

/** "1234.5" → "₹1,234.50" with Indian digit grouping (lakh, crore). */
export function rupees(amount: string | null | undefined): string {
  if (amount === null || amount === undefined || amount === '') return '—';
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) return amount;
  const [, sign, int, frac = ''] = m;
  const paise = (frac + '00').slice(0, 2);
  const zero = /^0+$/.test(int) && /^0*$/.test(frac);
  return `${sign && !zero ? '-' : ''}₹${groupIndian(int.replace(/^0+(?=\d)/, ''))}.${paise}`;
}

function groupIndian(int: string): string {
  if (int.length <= 3) return int;
  const last3 = int.slice(-3);
  const rest = int.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

/** "2.000" → "2", "1.500" → "1.5". */
export function qty(q: string | number): string {
  const s = String(q);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

const IST = 'Asia/Kolkata';

export function time(iso: string | Date): string {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: IST });
}

export function dateTime(iso: string | Date): string {
  return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: IST });
}

/** 75 → "1:15", 3725 → "1:02:05". */
export function elapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function titleCase(s: string): string {
  return s.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** A dish code made from its name when none is typed, e.g. "Mango Shake (Large)" → "MANGO-SHAKE-LARGE". */
export function skuFrom(name: string) {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

const BIGGER: Record<string, string> = { g: 'kg', ml: 'l' };

/** A stock quantity for display: 4800 g reads "4.8 kg", 250 ml "250 ml", 12 pc "12 pc". The server keeps the exact base amount. */
export function stockQty(q: string | number, unit: string): string {
  const n = Number(q);
  const fmt = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 3 });
  if (BIGGER[unit] && Math.abs(n) >= 1000) return `${fmt(n / 1000)} ${BIGGER[unit]}`;
  return `${fmt(n)} ${unit}`;
}

export const METHOD_LABEL: Record<string, string> = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', WALLET: 'Wallet', BANK_TRANSFER: 'Bank transfer', OTHER: 'Other' };

/** An amount typed by staff: rupees with up to 2 decimals. */
export const MONEY_INPUT = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/;

/** Today's date in India as YYYY-MM-DD (business dates are Indian dates, whatever the device clock zone). */
export function indiaDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** The first and last day of the month that contains the given India date. */
export function monthOf(date: string): { from: string; to: string } {
  const [y, m] = date.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, '0')}` };
}

/** A YYYY-MM-DD business date for display, e.g. "9 Nov 2026". */
export function shortDate(date: string): string {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Shifts a YYYY-MM-DD date by whole days. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type DatePreset = 'today' | 'yesterday' | 'this_week' | 'this_month' | 'last_month';

/** Report periods in India dates. Weeks start on Monday; "this week" and "this month" end today. */
export function presetRange(p: DatePreset, today: string = indiaDate()): { from: string; to: string } {
  if (p === 'today') return { from: today, to: today };
  if (p === 'yesterday') return { from: addDays(today, -1), to: addDays(today, -1) };
  if (p === 'this_week') {
    const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
    return { from: addDays(today, -dow), to: today };
  }
  if (p === 'this_month') return { from: monthOf(today).from, to: today };
  return monthOf(addDays(monthOf(today).from, -1));
}
