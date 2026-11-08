import PDFDocument from 'pdfkit';
import { Cell, Column, Report } from './report';

// ───────────── CSV ─────────────

/** Quotes a CSV cell and defuses spreadsheet formulas (a text cell starting with = + - @). */
export function csvCell(v: Cell): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const line = (cells: Cell[]) => cells.map(csvCell).join(',');

/**
 * One CSV file per report: a header block, the summary as label/value lines, then each table
 * under its title, separated by blank lines. Amounts are plain numbers (no grouping) so
 * spreadsheets read them as numbers.
 */
export function toCsv(r: Report): string {
  const out: string[] = [
    line([r.title]),
    line(['Period', r.from, r.to]),
    line(['Branches', r.branches.map((b) => b.name).join('; ')]),
    '',
    line(['Summary']),
    ...r.summary.map((s) => line([s.label, s.value])),
  ];
  for (const t of r.tables) {
    out.push('', line([t.title + (t.truncated ? ' (first rows only)' : '')]), line(t.columns.map((c) => c.label)));
    for (const row of t.rows) out.push(line(t.columns.map((c) => row[c.key] ?? null)));
  }
  for (const n of r.notes ?? []) out.push('', line([n]));
  // BOM so Excel opens UTF-8 (names in Hindi, ₹) correctly.
  return '﻿' + out.join('\r\n') + '\r\n';
}

// ───────────── PDF ─────────────

/** 1234567.5 → "12,34,567.50" (Indian digit grouping). */
export function formatIndian(v: string): string {
  const m = /^(-?)(\d+)(\.\d+)?$/.exec(v);
  if (!m) return v;
  const [, sign, int, frac = ''] = m;
  const last3 = int.slice(-3);
  const rest = int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return sign + (rest ? `${rest},${last3}` : last3) + frac;
}

const numeric = (c: Column) => c.type === 'money' || c.type === 'qty' || c.type === 'number' || c.type === 'percent';
const show = (c: Column | { type?: Column['type'] }, v: Cell): string => {
  if (v === null || v === undefined) return '-';
  const s = String(v);
  if (c.type === 'money') return formatIndian(s);
  if (c.type === 'percent') return `${s}%`;
  return s.replace(/₹/g, 'Rs.');
};

/** Standard PDF fonts cover Latin-1 only; anything else is shown as "?" rather than garbage. */
export const latin1 = (s: string) =>
  s
    .replace(/₹/g, 'Rs.')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

/**
 * A plain, printable A4 report: title, period, the summary in two columns, then each table with a
 * repeated header on every page and page numbers in the footer. Wide tables use landscape.
 */
export function toPdf(r: Report, generatedAt = new Date()): Promise<Buffer> {
  const wide = r.tables.some((t) => t.columns.length > 7);
  const doc = new PDFDocument({ size: 'A4', layout: wide ? 'landscape' : 'portrait', margin: 36, bufferPages: true, info: { Title: r.title, Author: 'RestaurantOS' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 20;

  doc.font('Helvetica-Bold').fontSize(16).text(latin1(r.title));
  doc.moveDown(0.2).font('Helvetica').fontSize(9).fillColor('#444');
  doc.text(latin1(`Period: ${r.from} to ${r.to}`));
  doc.text(latin1(`Branches: ${r.branches.map((b) => b.name).join(', ') || '–'}`));
  doc.text(`Generated: ${new Date(generatedAt.getTime() + 5.5 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')} IST`);
  doc.fillColor('#000').moveDown(0.6);

  // Summary: label/value pairs in two columns.
  if (r.summary.length) {
    const colW = width / 2;
    const rowH = 14;
    doc.fontSize(9);
    for (let i = 0; i < r.summary.length; i += 2) {
      if (doc.y + rowH > bottom()) doc.addPage();
      const y = doc.y;
      for (const [j, s] of r.summary.slice(i, i + 2).entries()) {
        const x = left + j * colW;
        doc.font('Helvetica').text(latin1(s.label), x, y, { width: colW * 0.6 - 6, lineBreak: false, ellipsis: true });
        doc.font('Helvetica-Bold').text(latin1(show(s, s.value)), x + colW * 0.6, y, { width: colW * 0.4 - 12, align: 'right', lineBreak: false });
      }
      doc.y = y + rowH;
    }
    doc.x = left;
    doc.moveDown(0.8);
  }

  for (const t of r.tables) {
    const weights = t.columns.map((c) => (numeric(c) ? 1 : 2));
    const total = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => (w / total) * width);
    const fontSize = t.columns.length > 10 ? 6.5 : t.columns.length > 7 ? 7.5 : 8.5;
    const rowH = fontSize + 6;

    const header = () => {
      const y = doc.y;
      doc.rect(left, y - 2, width, rowH).fill('#e8e8e8').fillColor('#000');
      let x = left;
      doc.font('Helvetica-Bold').fontSize(fontSize);
      t.columns.forEach((c, i) => {
        doc.text(latin1(c.label), x + 2, y + 1, { width: widths[i] - 4, align: numeric(c) ? 'right' : 'left', lineBreak: false, ellipsis: true });
        x += widths[i];
      });
      doc.y = y + rowH;
    };

    if (doc.y + rowH * 3 > bottom()) doc.addPage();
    doc.x = left;
    doc.font('Helvetica-Bold').fontSize(11).text(latin1(t.title + (t.truncated ? ' (first rows only)' : '')), left, doc.y);
    doc.moveDown(0.3);
    header();
    if (!t.rows.length) {
      doc.font('Helvetica-Oblique').fontSize(fontSize).text('No records in this period.', left + 2, doc.y + 1);
      doc.moveDown(0.5);
    }
    doc.font('Helvetica').fontSize(fontSize);
    for (const [n, row] of t.rows.entries()) {
      if (doc.y + rowH > bottom()) {
        doc.addPage();
        header();
        doc.font('Helvetica').fontSize(fontSize);
      }
      const y = doc.y;
      if (n % 2 === 1) doc.rect(left, y - 2, width, rowH).fill('#f6f6f6').fillColor('#000');
      let x = left;
      t.columns.forEach((c, i) => {
        doc.text(latin1(show(c, row[c.key] ?? null)), x + 2, y + 1, { width: widths[i] - 4, align: numeric(c) ? 'right' : 'left', lineBreak: false, ellipsis: true });
        x += widths[i];
      });
      doc.y = y + rowH;
    }
    doc.x = left;
    doc.moveDown(1);
  }

  for (const n of r.notes ?? []) {
    if (doc.y + 30 > bottom()) doc.addPage();
    doc.font('Helvetica-Oblique').fontSize(8).fillColor('#444').text(latin1(n), left, doc.y, { width });
    doc.fillColor('#000');
  }

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const y = doc.page.height - doc.page.margins.bottom - 14;
    doc.font('Helvetica').fontSize(7).fillColor('#666');
    doc.text(latin1(`${r.title} · ${r.from} to ${r.to}`), left, y, { width: width / 2, lineBreak: false });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, left + width / 2, y, { width: width / 2, align: 'right', lineBreak: false });
  }
  doc.end();
  return done;
}
