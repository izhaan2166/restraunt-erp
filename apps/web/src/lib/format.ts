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
