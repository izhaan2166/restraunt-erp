import { PaymentStatus, Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;
const Dec = Prisma.Decimal;
const ZERO = new Dec(0);

export interface InvoiceMoney {
  grandTotal: Prisma.Decimal;
  paidAmount: Prisma.Decimal;
  refundedAmount: Prisma.Decimal;
}

/**
 * Where an invoice stands once payments, refunds and credit notes are taken into account.
 *   due         = grand total − credit notes (0 once every line is fully credited)
 *   netPaid     = payments received − refunds paid out
 *   outstanding = what the customer still owes; refundDue = what we owe the customer
 */
export function settlement(inv: InvoiceMoney, credited: Prisma.Decimal, fullyCredited: boolean) {
  const due = fullyCredited ? ZERO : Dec.max(inv.grandTotal.sub(credited), ZERO);
  const netPaid = inv.paidAmount.sub(inv.refundedAmount);
  const outstanding = Dec.max(due.sub(netPaid), ZERO);
  const refundDue = Dec.max(netPaid.sub(due), ZERO);
  const settled = outstanding.isZero();
  let paymentStatus: PaymentStatus;
  if (settled) paymentStatus = inv.refundedAmount.isZero() ? 'PAID' : netPaid.isZero() ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  else paymentStatus = netPaid.gt(0) ? 'PARTIALLY_PAID' : 'UNPAID';
  return { due, netPaid, outstanding, refundDue, settled, paymentStatus };
}

/** Credited total and whether every invoice line has been fully credited. */
export async function creditPosition(tx: Tx | Prisma.TransactionClient, invoiceId: string) {
  const [notes, items, credited] = await Promise.all([
    tx.creditNote.aggregate({ where: { invoiceId }, _sum: { totalAmount: true } }),
    tx.invoiceItem.findMany({ where: { invoiceId }, select: { id: true, quantity: true } }),
    tx.creditNoteItem.groupBy({ by: ['invoiceItemId'], where: { creditNote: { invoiceId } }, _sum: { quantity: true } }),
  ]);
  const byItem = new Map(credited.map((c) => [c.invoiceItemId, c._sum.quantity ?? ZERO]));
  const fullyCredited = items.length > 0 && items.every((i) => (byItem.get(i.id) ?? ZERO).gte(i.quantity));
  return { credited: notes._sum.totalAmount ?? ZERO, fullyCredited, creditedQty: byItem };
}

/**
 * Re-derives the invoice's payment status and mirrors it onto the order (paid amount, payment
 * status) and the dine-in table (BILL_PENDING while money is owed, OCCUPIED once settled).
 */
export async function syncSettlement(tx: Tx, invoiceId: string) {
  const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  const { credited, fullyCredited } = await creditPosition(tx, invoiceId);
  const s = settlement(inv, credited, fullyCredited);
  await tx.invoice.update({ where: { id: invoiceId }, data: { paymentStatus: s.paymentStatus } });
  if (inv.status !== 'CANCELLED') {
    const order = await tx.order.update({
      where: { id: inv.orderId },
      data: { paidAmount: s.netPaid, paymentStatus: s.paymentStatus },
      include: { tableSession: { select: { tableId: true, closedAt: true } } },
    });
    if (order.tableSession && !order.tableSession.closedAt) {
      await tx.restaurantTable.updateMany({
        where: { id: order.tableSession.tableId, status: { in: ['OCCUPIED', 'BILL_PENDING'] } },
        data: { status: s.settled ? 'OCCUPIED' : 'BILL_PENDING', version: { increment: 1 } },
      });
    }
  }
  return { ...s, credited, fullyCredited };
}
