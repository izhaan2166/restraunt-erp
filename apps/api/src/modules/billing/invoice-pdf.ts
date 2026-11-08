import PDFDocument from 'pdfkit';
import { formatIndian, latin1 } from '../reports/export';

type Dec = { toString(): string; toFixed(n: number): string };
const m = (d: Dec | null | undefined) => formatIndian(d ? d.toFixed(2) : '0.00');

export interface InvoiceForPdf {
  invoiceNumber: string;
  invoiceDate: Date;
  status: string;
  supplyType: string;
  placeOfSupply: string;
  sellerDetails: unknown;
  buyerName: string | null;
  buyerGstin: string | null;
  subtotal: Dec;
  discountTotal: Dec;
  taxableAmount: Dec;
  cgstAmount: Dec;
  sgstAmount: Dec;
  igstAmount: Dec;
  taxTotal: Dec;
  roundOff: Dec;
  grandTotal: Dec;
  items: { lineNo: number; description: string; hsnSac: string | null; quantity: Dec; unitPrice: Dec; discount: Dec; taxableAmount: Dec; cgstRate: Dec; sgstRate: Dec; igstRate: Dec; lineTotal: Dec }[];
  taxSummary: { rate: Dec; taxableAmount: Dec; cgstAmount: Dec; sgstAmount: Dec; igstAmount: Dec }[];
  payments: { method: string; amount: Dec; allocated: Dec; receivedAt: Date; status: string }[];
  creditNotes: { creditNoteNumber: string; createdAt: Date; totalAmount: Dec; reason: string }[];
  creditedAmount: Dec;
  netPaid: Dec;
  outstanding: Dec;
  order: { orderNumber: string; orderType: string; tableSession: { table: { label: string } } | null };
}

const ist = (d: Date) => new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');

/**
 * A GST tax invoice on A4, drawn from the stored (final) invoice: seller and buyer details, one
 * line per item with HSN/SAC and rates, the tax summary by rate, totals, payments and any credit
 * notes. It reprints the same document every time; nothing is recalculated.
 */
export function invoicePdf(inv: InvoiceForPdf): Promise<Buffer> {
  const seller = (inv.sellerDetails ?? {}) as Record<string, string | null | undefined>;
  const doc = new PDFDocument({ size: 'A4', margin: 36, info: { Title: `Invoice ${inv.invoiceNumber}`, Author: 'RestaurantOS' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const left = 36;
  const width = doc.page.width - 72;
  const bottom = doc.page.height - 60;

  doc.font('Helvetica-Bold').fontSize(15).text(latin1(seller.tradeName ?? seller.legalName ?? ''), left, 36);
  doc.font('Helvetica').fontSize(8.5);
  if (seller.legalName && seller.legalName !== seller.tradeName) doc.text(latin1(seller.legalName));
  for (const l of [seller.branch, seller.address, seller.phone ? `Phone: ${seller.phone}` : null, seller.gstin ? `GSTIN: ${seller.gstin}` : null, seller.pan ? `PAN: ${seller.pan}` : null]) {
    if (l) doc.text(latin1(l));
  }
  doc.font('Helvetica-Bold').fontSize(13).text(inv.status === 'CANCELLED' ? 'TAX INVOICE (CANCELLED)' : 'TAX INVOICE', left, 36, { width, align: 'right' });
  doc.font('Helvetica').fontSize(8.5);
  const meta = [
    `Invoice no.: ${inv.invoiceNumber}`,
    `Date: ${ist(inv.invoiceDate)} IST`,
    `Order: ${inv.order.orderNumber} (${inv.order.orderType.replace('_', ' ').toLowerCase()})`,
    inv.order.tableSession ? `Table: ${inv.order.tableSession.table.label}` : null,
    `Place of supply: ${inv.placeOfSupply}`,
  ].filter((x): x is string => !!x);
  for (const l of meta) doc.text(latin1(l), left, undefined, { width, align: 'right' });
  doc.moveDown(0.6);
  if (inv.buyerName || inv.buyerGstin) {
    doc.font('Helvetica-Bold').text('Billed to', left);
    doc.font('Helvetica');
    if (inv.buyerName) doc.text(latin1(inv.buyerName));
    if (inv.buyerGstin) doc.text(`GSTIN: ${inv.buyerGstin}`);
    doc.moveDown(0.4);
  }

  const inter = inv.supplyType !== 'INTRA_STATE';
  const cols = [
    { label: '#', w: 0.04, right: false },
    { label: 'Item', w: 0.34, right: false },
    { label: 'HSN/SAC', w: 0.09, right: false },
    { label: 'Qty', w: 0.07, right: true },
    { label: 'Rate', w: 0.1, right: true },
    { label: 'Discount', w: 0.09, right: true },
    { label: 'Taxable', w: 0.1, right: true },
    { label: 'GST %', w: 0.07, right: true },
    { label: 'Amount', w: 0.1, right: true },
  ];
  const row = (cells: string[], bold = false, shade = false) => {
    if (doc.y + 14 > bottom) doc.addPage();
    const y = doc.y;
    if (shade) doc.rect(left, y - 2, width, 14).fill('#e8e8e8').fillColor('#000');
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
    let x = left;
    cells.forEach((c, i) => {
      doc.text(latin1(c), x + 2, y + 1, { width: cols[i].w * width - 4, align: cols[i].right ? 'right' : 'left', lineBreak: false, ellipsis: true });
      x += cols[i].w * width;
    });
    doc.y = y + 14;
  };
  row(cols.map((c) => c.label), true, true);
  for (const it of inv.items) {
    const rate = inter ? it.igstRate.toString() : (Number(it.cgstRate.toString()) + Number(it.sgstRate.toString())).toString();
    row([String(it.lineNo), it.description, it.hsnSac ?? '', it.quantity.toString(), m(it.unitPrice), m(it.discount), m(it.taxableAmount), rate, m(it.lineTotal)]);
  }
  doc.moveDown(0.6);

  const pair = (label: string, value: string, bold = false) => {
    if (doc.y + 13 > bottom) doc.addPage();
    const y = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 10 : 8.5);
    doc.text(latin1(label), left + width * 0.55, y, { width: width * 0.28, lineBreak: false });
    doc.text(latin1(value), left + width * 0.83, y, { width: width * 0.17, align: 'right', lineBreak: false });
    doc.y = y + (bold ? 15 : 12);
  };
  pair('Subtotal', m(inv.subtotal));
  if (!inv.discountTotal.toString().match(/^0(\.0+)?$/)) pair('Discount', `-${m(inv.discountTotal)}`);
  pair('Taxable value', m(inv.taxableAmount));
  if (inter) pair('IGST', m(inv.igstAmount));
  else {
    pair('CGST', m(inv.cgstAmount));
    pair('SGST', m(inv.sgstAmount));
  }
  pair('Round off', m(inv.roundOff));
  pair('Total (Rs.)', m(inv.grandTotal), true);
  doc.moveDown(0.5);

  doc.font('Helvetica-Bold').fontSize(9).text('Tax summary', left);
  doc.font('Helvetica').fontSize(8);
  for (const t of inv.taxSummary) {
    doc.text(latin1(`GST ${t.rate.toString()}%: taxable ${m(t.taxableAmount)}${inter ? `, IGST ${m(t.igstAmount)}` : `, CGST ${m(t.cgstAmount)}, SGST ${m(t.sgstAmount)}`}`), left);
  }
  const paid = inv.payments.filter((p) => p.status === 'COMPLETED');
  if (paid.length) {
    doc.moveDown(0.4).font('Helvetica-Bold').fontSize(9).text('Payments', left);
    doc.font('Helvetica').fontSize(8);
    for (const p of paid) doc.text(latin1(`${ist(p.receivedAt)}  ${p.method}  ${m(p.allocated)}`), left);
  }
  if (inv.creditNotes.length) {
    doc.moveDown(0.4).font('Helvetica-Bold').fontSize(9).text('Credit notes', left);
    doc.font('Helvetica').fontSize(8);
    for (const c of inv.creditNotes) doc.text(latin1(`${c.creditNoteNumber}  ${ist(c.createdAt)}  ${m(c.totalAmount)}  ${c.reason}`), left);
  }
  doc.moveDown(0.4).font('Helvetica').fontSize(8.5);
  doc.text(latin1(`Paid: ${m(inv.netPaid)}    Balance due: ${m(inv.outstanding)}`), left);
  doc.moveDown(1).fontSize(7.5).fillColor('#555').text('This is a computer-generated invoice.', left, undefined, { width, align: 'center' });
  doc.end();
  return done;
}
