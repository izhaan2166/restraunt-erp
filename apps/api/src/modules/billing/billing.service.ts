import { Injectable } from '@nestjs/common';
import { Prisma, Refund } from '@prisma/client';
import { requireInBranch } from '../../common/auth/branch-access';
import { Paginated } from '../../common/dto/pagination';
import { Errors } from '../../common/errors/app-error';
import type { RequestMeta } from '../../common/http/request-meta';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthPrincipal } from '../auth/principal';
import { branchBilling, recomputeOrder } from '../orders/order-pricing';
import { OrdersService } from '../orders/orders.service';
import { financialYear, nextNumber } from '../sequences/sequences';
import { drawerForCash, postCash } from '../cash/drawer';
import { restockForRefund } from '../inventory/stock';
import {
  BuyerDto,
  CheckoutDto,
  CreditNoteDto,
  ListInvoicesQuery,
  ListRefundsQuery,
  PaymentInputDto,
  RefundDto,
} from './dto/billing.dto';
import { money } from './engine';
import { creditPosition, settlement, syncSettlement } from './settlement';

type Tx = Prisma.TransactionClient;
const Dec = Prisma.Decimal;
const ZERO = new Dec(0);
const SAC_RESTAURANT_SERVICE = '996331';

const INVOICE_DETAIL = {
  items: { orderBy: { lineNo: 'asc' } },
  allocations: { include: { payment: true } },
  refunds: { orderBy: { createdAt: 'asc' } },
  creditNotes: { orderBy: { createdAt: 'asc' }, include: { items: true } },
  order: { select: { id: true, orderNumber: true, orderType: true, status: true, tableSession: { select: { table: { select: { label: true } } } } } },
} satisfies Prisma.InvoiceInclude;

type InvoiceRow = Prisma.InvoiceGetPayload<{ include: typeof INVOICE_DETAIL }>;

/**
 * Invoices (GST tax invoices), payments, refunds and credit notes. Invoices are issued final:
 * they are numbered from a gap-free per-branch, per-financial-year series in the same transaction
 * that writes them, and the database refuses any later change to their contents (Phase 1
 * trigger). Corrections are credit notes; money back is a refund against an original payment.
 */
@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly orders: OrdersService,
  ) {}

  // ───────────── Read ─────────────

  async list(actor: AuthPrincipal, q: ListInvoicesQuery) {
    const where: Prisma.InvoiceWhereInput = {
      organizationId: actor.organizationId,
      branchId: q.branchId,
      status: q.status,
      invoiceDate: q.from || q.to ? { gte: q.from ? new Date(q.from) : undefined, lte: q.to ? new Date(q.to) : undefined } : undefined,
      ...(q.search ? { OR: [{ invoiceNumber: { contains: q.search, mode: 'insensitive' } }, { buyerGstin: { contains: q.search.toUpperCase() } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.invoice.findMany({ where, orderBy: { invoiceDate: q.order }, skip: q.skip, take: q.pageSize }),
      this.prisma.invoice.count({ where }),
    ]);
    return new Paginated(rows, total, q);
  }

  async get(actor: AuthPrincipal, id: string, db: Tx | PrismaService = this.prisma) {
    const inv = await db.invoice.findFirst({ where: { id, organizationId: actor.organizationId }, include: INVOICE_DETAIL });
    if (!inv) throw Errors.notFound('Invoice');
    requireInBranch(actor, inv.branchId, ['invoices.read'], 'Invoice');
    return present(inv, await creditPosition(db as Tx, id));
  }

  async listRefunds(actor: AuthPrincipal, q: ListRefundsQuery) {
    return this.prisma.refund.findMany({
      where: { organizationId: actor.organizationId, branchId: q.branchId, status: q.status },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { invoice: { select: { invoiceNumber: true } } },
    });
  }

  // ───────────── Issue ─────────────

  async createInvoice(actor: AuthPrincipal, orderId: string, buyer: BuyerDto, meta: RequestMeta) {
    const id = await this.prisma.$transaction((tx) => this.issue(tx, actor, orderId, buyer, meta));
    return this.get(actor, id);
  }

  /** Bill + payments in one transaction: issues the invoice if needed, then records each payment. */
  async checkout(actor: AuthPrincipal, dto: CheckoutDto, meta: RequestMeta) {
    const id = await this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({ where: { id: dto.orderId, organizationId: actor.organizationId } });
      if (!order) throw Errors.notFound('Order');
      requireInBranch(actor, order.branchId, ['billing.checkout', ...(dto.payments.length ? ['payments.create'] : [])], 'Order');
      const existing = await tx.invoice.findFirst({ where: { orderId: order.id, status: 'FINALIZED' } });
      const invoiceId = existing?.id ?? (await this.issue(tx, actor, order.id, dto, meta));
      for (const p of dto.payments) await this.recordPayment(tx, actor, invoiceId, p, null, meta);
      return invoiceId;
    });
    return this.get(actor, id);
  }

  private async issue(tx: Tx, actor: AuthPrincipal, orderId: string, buyer: BuyerDto, meta: RequestMeta): Promise<string> {
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid AND organization_id = ${actor.organizationId}::uuid FOR UPDATE`;
    const order = await tx.order.findFirst({ where: { id: orderId, organizationId: actor.organizationId } });
    if (!order) throw Errors.notFound('Order');
    requireInBranch(actor, order.branchId, ['invoices.create'], 'Order');
    if (order.status === 'CANCELLED') throw Errors.unprocessable('ORDER_CANCELLED', 'A cancelled order cannot be billed');
    const active = await tx.invoice.findFirst({ where: { orderId, status: { not: 'CANCELLED' } } });
    if (active) throw Errors.conflict('ALREADY_INVOICED', `Invoice ${active.invoiceNumber} is already issued for this order`, { invoiceId: active.id });

    // Re-run the engine so the invoice is built from exactly what the engine says now.
    const { result, settings } = await recomputeOrder(tx, orderId);
    if (!result.lines.length) throw Errors.unprocessable('ORDER_EMPTY', 'The order has no items to bill');
    const items = await tx.orderItem.findMany({ where: { orderId, status: 'ACTIVE' }, include: { modifiers: true }, orderBy: { createdAt: 'asc' } });
    const [org, branch] = await Promise.all([
      tx.organization.findUniqueOrThrow({ where: { id: actor.organizationId } }),
      tx.branch.findUniqueOrThrow({ where: { id: order.branchId } }),
    ]);

    const now = new Date();
    const fy = financialYear(now);
    const { sequenceId, value } = await nextNumber(tx, {
      organizationId: actor.organizationId,
      branchId: order.branchId,
      type: 'INVOICE',
      prefix: settings.invoicePrefix,
      period: fy,
    });
    const invoiceNumber = `${settings.invoicePrefix}/${fy}/${value}`;
    const half = (r: Prisma.Decimal) => r.div(2);

    const lines: Prisma.InvoiceItemCreateWithoutInvoiceInput[] = items.map((it, idx) => {
      const mods = it.modifiers.map((m) => (m.quantity > 1 ? `${m.name} ×${m.quantity}` : m.name));
      return {
        lineNo: idx + 1,
        orderItem: { connect: { id: it.id } },
        description: [it.productName, it.variantName ? `(${it.variantName})` : null, mods.length ? `+ ${mods.join(', ')}` : null].filter(Boolean).join(' '),
        hsnSac: it.hsnSac ?? SAC_RESTAURANT_SERVICE,
        quantity: it.quantity,
        unitPrice: money(it.lineSubtotal.div(it.quantity)),
        discount: it.discountAmount,
        taxableAmount: it.taxableAmount,
        cgstRate: it.cgstAmount.gt(0) || it.sgstAmount.gt(0) ? half(it.taxRate) : ZERO,
        cgstAmount: it.cgstAmount,
        sgstRate: it.cgstAmount.gt(0) || it.sgstAmount.gt(0) ? half(it.taxRate) : ZERO,
        sgstAmount: it.sgstAmount,
        igstRate: it.igstAmount.gt(0) ? it.taxRate : ZERO,
        igstAmount: it.igstAmount,
        lineTotal: it.lineTotal,
      };
    });
    for (const sc of result.serviceCharges) {
      lines.push({
        lineNo: lines.length + 1,
        description: `Service charge ${settings.serviceChargePercent.toString()}% (GST ${sc.taxRate.toString()}%)`,
        hsnSac: SAC_RESTAURANT_SERVICE,
        quantity: 1,
        unitPrice: sc.taxableAmount,
        taxableAmount: sc.taxableAmount,
        cgstRate: sc.cgstAmount.gt(0) ? half(sc.taxRate) : ZERO,
        cgstAmount: sc.cgstAmount,
        sgstRate: sc.sgstAmount.gt(0) ? half(sc.taxRate) : ZERO,
        sgstAmount: sc.sgstAmount,
        igstRate: sc.igstAmount.gt(0) ? sc.taxRate : ZERO,
        igstAmount: sc.igstAmount,
        lineTotal: sc.lineTotal,
      });
    }

    // Items can only be written while the invoice is a draft (DB trigger), so the invoice is
    // created as DRAFT and finalized in the same transaction; no draft is ever visible.
    const inv = await tx.invoice.create({
      data: {
        organizationId: actor.organizationId,
        branchId: order.branchId,
        orderId,
        sequenceId,
        invoiceNumber,
        invoiceDate: now,
        status: 'DRAFT',
        supplyType: 'INTRA_STATE',
        placeOfSupply: branch.stateCode,
        sellerDetails: {
          legalName: org.legalName ?? org.name,
          tradeName: org.name,
          gstin: branch.gstin ?? org.gstin,
          pan: org.pan,
          branch: branch.name,
          address: [branch.address, branch.city, branch.pincode].filter(Boolean).join(', ') || org.address,
          stateCode: branch.stateCode,
          phone: branch.phone ?? org.phone,
        },
        buyerName: buyer.buyerName?.trim() || order.customerName,
        buyerGstin: buyer.buyerGstin ?? null,
        subtotal: result.subtotal,
        discountTotal: result.discountTotal,
        taxableAmount: result.taxableAmount,
        cgstAmount: result.cgstAmount,
        sgstAmount: result.sgstAmount,
        igstAmount: result.igstAmount,
        taxTotal: result.taxTotal,
        serviceCharge: result.serviceCharge,
        roundOff: result.roundOff,
        grandTotal: result.grandTotal,
        createdById: actor.userId,
        items: { create: lines },
      },
    });
    await tx.invoice.update({ where: { id: inv.id }, data: { status: 'FINALIZED', finalizedAt: now, finalizedById: actor.userId } });
    await syncSettlement(tx, inv.id);
    await this.orders.completeIfSettled(tx, actor, orderId);
    await this.audit.record(
      {
        organizationId: actor.organizationId,
        branchId: order.branchId,
        actorUserId: actor.userId,
        action: 'invoice.issued',
        entityType: 'invoice',
        entityId: inv.id,
        after: { invoiceNumber, orderId, grandTotal: result.grandTotal, taxTotal: result.taxTotal, buyerGstin: buyer.buyerGstin ?? null },
        meta,
      },
      tx,
    );
    return inv.id;
  }

  // ───────────── Payments ─────────────

  async pay(actor: AuthPrincipal, invoiceId: string, dto: PaymentInputDto, idempotencyKey: string | null, meta: RequestMeta) {
    await this.prisma.$transaction((tx) => this.recordPayment(tx, actor, invoiceId, dto, idempotencyKey, meta));
    return this.get(actor, invoiceId);
  }

  private async recordPayment(tx: Tx, actor: AuthPrincipal, invoiceId: string, dto: PaymentInputDto, idempotencyKey: string | null, meta: RequestMeta) {
    const inv = await this.lockInvoice(tx, actor, invoiceId, ['payments.create']);
    if (inv.status !== 'FINALIZED') throw Errors.unprocessable('INVOICE_NOT_PAYABLE', `Invoice ${inv.invoiceNumber} is ${inv.status.toLowerCase()}`);
    const amount = new Dec(dto.amount);
    if (amount.lte(0)) throw Errors.badRequest('INVALID_AMOUNT', 'amount must be greater than 0');
    const { credited, fullyCredited } = await creditPosition(tx, invoiceId);
    const s = settlement(inv, credited, fullyCredited);
    if (amount.gt(s.outstanding)) {
      throw Errors.unprocessable('AMOUNT_EXCEEDS_OUTSTANDING', `Only ₹${s.outstanding.toFixed(2)} is outstanding on this bill`, {
        outstanding: s.outstanding.toFixed(2),
      });
    }
    // Cash goes into the receiver's drawer (their open cash shift).
    const drawer = dto.method === 'CASH' ? await drawerForCash(tx, inv.branchId, [actor.userId]) : null;
    const payment = await tx.payment.create({
      data: {
        organizationId: actor.organizationId,
        branchId: inv.branchId,
        orderId: inv.orderId,
        method: dto.method,
        amount,
        reference: dto.reference?.trim() || null,
        idempotencyKey,
        receivedById: actor.userId,
        cashSessionId: drawer?.id ?? null,
        allocations: { create: { invoiceId, amount } },
      },
    });
    if (drawer) {
      await postCash(tx, drawer, { type: 'CASH_SALE', amount, referenceType: 'payment', referenceId: payment.id, note: inv.invoiceNumber, userId: actor.userId });
    }
    await tx.invoice.update({ where: { id: invoiceId }, data: { paidAmount: { increment: amount } } });
    const after = await syncSettlement(tx, invoiceId);
    const completed = await this.orders.completeIfSettled(tx, actor, inv.orderId);
    await this.audit.record(
      {
        organizationId: actor.organizationId,
        branchId: inv.branchId,
        actorUserId: actor.userId,
        action: 'payment.recorded',
        entityType: 'payment',
        entityId: payment.id,
        after: { invoiceId, invoiceNumber: inv.invoiceNumber, method: dto.method, amount, reference: payment.reference, outstanding: after.outstanding, orderCompleted: completed },
        meta,
      },
      tx,
    );
    return payment;
  }

  // ───────────── Refunds ─────────────

  /**
   * Money back against one original payment, never more than that payment minus what was already
   * refunded from it. Staff without `refunds.approve` create a PENDING refund that a manager approves.
   */
  async refund(actor: AuthPrincipal, invoiceId: string, dto: RefundDto, idempotencyKey: string | null, meta: RequestMeta) {
    const refundId = await this.prisma.$transaction(async (tx) => {
      const inv = await this.lockInvoice(tx, actor, invoiceId, ['refunds.create']);
      if (inv.status === 'DRAFT') throw Errors.unprocessable('INVOICE_NOT_FINAL', 'Draft invoices cannot be refunded');
      const alloc = await tx.paymentAllocation.findFirst({ where: { invoiceId, paymentId: dto.paymentId }, include: { payment: true } });
      if (!alloc || alloc.payment.status !== 'COMPLETED') throw Errors.badRequest('INVALID_PAYMENT', 'Payment not found on this invoice');
      const amount = new Dec(dto.amount);
      if (amount.lte(0)) throw Errors.badRequest('INVALID_AMOUNT', 'amount must be greater than 0');
      const already = await tx.refund.aggregate({ where: { paymentId: dto.paymentId, status: { in: ['PENDING', 'COMPLETED'] } }, _sum: { amount: true } });
      const refundable = alloc.payment.amount.sub(already._sum.amount ?? ZERO);
      if (amount.gt(refundable)) {
        throw Errors.unprocessable('REFUND_EXCEEDS_PAYMENT', `At most ₹${refundable.toFixed(2)} can still be refunded from this payment`, { refundable: refundable.toFixed(2) });
      }
      if (dto.restock && !dto.creditNoteId) {
        throw Errors.badRequest('RESTOCK_NEEDS_CREDIT_NOTE', 'Restocking puts back the credited items: create a credit note for them and refund against it');
      }
      if (dto.creditNoteId) {
        const cn = await tx.creditNote.findFirst({ where: { id: dto.creditNoteId, invoiceId } });
        if (!cn) throw Errors.badRequest('INVALID_CREDIT_NOTE', 'Credit note not found on this invoice');
        const against = await tx.refund.aggregate({ where: { creditNoteId: cn.id, status: { in: ['PENDING', 'COMPLETED'] } }, _sum: { amount: true } });
        if (amount.add(against._sum.amount ?? ZERO).gt(cn.totalAmount)) {
          throw Errors.unprocessable('REFUND_EXCEEDS_CREDIT_NOTE', `Credit note ${cn.creditNoteNumber} covers ₹${cn.totalAmount.toFixed(2)}`);
        }
      }
      const canApprove = actor.permissions.has('refunds.approve', inv.branchId);
      const refund = await tx.refund.create({
        data: {
          organizationId: actor.organizationId,
          branchId: inv.branchId,
          paymentId: dto.paymentId,
          invoiceId,
          creditNoteId: dto.creditNoteId ?? null,
          method: dto.method ?? alloc.payment.method,
          amount,
          reason: dto.reason.trim(),
          restock: dto.restock ?? false,
          status: canApprove ? 'COMPLETED' : 'PENDING',
          approvedById: canApprove ? actor.userId : null,
          idempotencyKey,
          processedById: actor.userId,
        },
      });
      if (canApprove) await this.applyRefund(tx, actor, refund);
      await this.audit.record(
        {
          organizationId: actor.organizationId,
          branchId: inv.branchId,
          actorUserId: actor.userId,
          action: canApprove ? 'refund.completed' : 'refund.requested',
          entityType: 'refund',
          entityId: refund.id,
          after: { invoiceNumber: inv.invoiceNumber, paymentId: dto.paymentId, amount, method: refund.method, reason: refund.reason, creditNoteId: refund.creditNoteId },
          meta,
        },
        tx,
      );
      return refund.id;
    });
    return this.prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
  }

  async decideRefund(actor: AuthPrincipal, refundId: string, approve: boolean, reason: string | null, meta: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.refund.findFirst({ where: { id: refundId, organizationId: actor.organizationId } });
      if (!r) throw Errors.notFound('Refund');
      requireInBranch(actor, r.branchId, ['refunds.approve'], 'Refund');
      await this.lockInvoice(tx, actor, r.invoiceId, []);
      // Re-read under the invoice lock so two approvers cannot both apply it.
      const fresh = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
      if (fresh.status !== 'PENDING') throw Errors.conflict('REFUND_NOT_PENDING', `This refund is already ${fresh.status.toLowerCase()}`);
      if (approve && fresh.processedById === actor.userId) {
        throw Errors.forbidden('SELF_APPROVAL', 'A refund must be approved by someone other than the person who requested it');
      }
      const decided = await tx.refund.update({ where: { id: refundId }, data: { status: approve ? 'COMPLETED' : 'VOIDED', approvedById: actor.userId } });
      if (approve) await this.applyRefund(tx, actor, decided);
      await this.audit.record(
        {
          organizationId: actor.organizationId,
          branchId: r.branchId,
          actorUserId: actor.userId,
          action: approve ? 'refund.approved' : 'refund.rejected',
          entityType: 'refund',
          entityId: refundId,
          before: { status: 'PENDING' },
          after: { status: approve ? 'COMPLETED' : 'VOIDED', reason },
          meta,
        },
        tx,
      );
    });
    return this.prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
  }

  private async applyRefund(tx: Tx, actor: AuthPrincipal, refund: Refund) {
    if (refund.method === 'CASH') {
      // Paid out of the requester's drawer if they have one open, otherwise the approver's.
      const drawer = await drawerForCash(tx, refund.branchId, [refund.processedById, actor.userId]);
      if (drawer) {
        await postCash(tx, drawer, { type: 'CASH_REFUND', amount: refund.amount.neg(), referenceType: 'refund', referenceId: refund.id, note: refund.reason, userId: actor.userId });
        await tx.refund.update({ where: { id: refund.id }, data: { cashSessionId: drawer.id } });
      }
    }
    await tx.invoice.update({ where: { id: refund.invoiceId }, data: { refundedAmount: { increment: refund.amount } } });
    await syncSettlement(tx, refund.invoiceId);
    await restockForRefund(tx, actor.userId, refund);
  }

  // ───────────── Credit notes & cancellation ─────────────

  async createCreditNote(actor: AuthPrincipal, invoiceId: string, dto: CreditNoteDto, meta: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      const inv = await this.lockInvoice(tx, actor, invoiceId, ['credit_notes.create']);
      if (inv.status !== 'FINALIZED') throw Errors.unprocessable('INVOICE_NOT_FINAL', `Invoice ${inv.invoiceNumber} is ${inv.status.toLowerCase()}`);
      await this.writeCreditNote(tx, actor, inv, dto.reason, dto.lines, meta);
    });
    return this.get(actor, invoiceId);
  }

  /**
   * Cancels an invoice by crediting whatever is not yet credited. Only possible once no money is
   * held against it (refund payments first). The order can then be changed and billed again.
   */
  async cancelInvoice(actor: AuthPrincipal, invoiceId: string, reason: string, meta: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      const inv = await this.lockInvoice(tx, actor, invoiceId, ['credit_notes.create']);
      if (inv.status !== 'FINALIZED') throw Errors.unprocessable('INVOICE_NOT_FINAL', `Invoice ${inv.invoiceNumber} is ${inv.status.toLowerCase()}`);
      const net = inv.paidAmount.sub(inv.refundedAmount);
      if (net.gt(0)) {
        throw Errors.conflict('INVOICE_HAS_PAYMENTS', `₹${net.toFixed(2)} has been paid on this invoice; refund it before cancelling`, { netPaid: net.toFixed(2) });
      }
      const { creditedQty } = await creditPosition(tx, invoiceId);
      const remaining = inv.items
        .map((i) => ({ invoiceItemId: i.id, quantity: i.quantity.sub(creditedQty.get(i.id) ?? ZERO) }))
        .filter((l) => l.quantity.gt(0))
        .map((l) => ({ invoiceItemId: l.invoiceItemId, quantity: l.quantity.toString() }));
      if (remaining.length) await this.writeCreditNote(tx, actor, inv, `Invoice cancelled: ${reason.trim()}`, remaining, meta);
      await tx.invoice.update({ where: { id: invoiceId }, data: { status: 'CANCELLED' } });
      await tx.order.update({ where: { id: inv.orderId }, data: { paidAmount: 0, paymentStatus: 'UNPAID', version: { increment: 1 } } });
      const order = await tx.order.findUniqueOrThrow({ where: { id: inv.orderId }, include: { tableSession: true } });
      if (order.tableSession && !order.tableSession.closedAt) {
        await tx.restaurantTable.updateMany({ where: { id: order.tableSession.tableId, status: 'BILL_PENDING' }, data: { status: 'OCCUPIED', version: { increment: 1 } } });
      }
      await this.audit.record(
        { organizationId: actor.organizationId, branchId: inv.branchId, actorUserId: actor.userId, action: 'invoice.cancelled', entityType: 'invoice', entityId: invoiceId, before: { status: 'FINALIZED' }, after: { status: 'CANCELLED', reason }, meta },
        tx,
      );
    });
    return this.get(actor, invoiceId);
  }

  private async writeCreditNote(
    tx: Tx,
    actor: AuthPrincipal,
    inv: Awaited<ReturnType<BillingService['lockInvoice']>>,
    reason: string,
    lines: { invoiceItemId: string; quantity: string }[],
    meta: RequestMeta,
  ) {
    const { creditedQty } = await creditPosition(tx, inv.id);
    const previous = await tx.creditNoteItem.findMany({ where: { creditNote: { invoiceId: inv.id } } });
    const seen = new Set<string>();
    const rows = lines.map((l) => {
      if (seen.has(l.invoiceItemId)) throw Errors.badRequest('DUPLICATE_LINE', 'Each invoice line may appear once');
      seen.add(l.invoiceItemId);
      const item = inv.items.find((i) => i.id === l.invoiceItemId);
      if (!item) throw Errors.badRequest('INVALID_INVOICE_ITEM', `Line ${l.invoiceItemId} is not on this invoice`);
      const qty = new Dec(l.quantity);
      if (qty.lte(0)) throw Errors.badRequest('INVALID_QUANTITY', 'quantity must be greater than 0');
      const remaining = item.quantity.sub(creditedQty.get(item.id) ?? ZERO);
      if (qty.gt(remaining)) {
        throw Errors.unprocessable('EXCEEDS_INVOICED_QUANTITY', `Only ${remaining.toString()} of "${item.description}" can still be credited`, { remaining: remaining.toString() });
      }
      const itemTax = item.cgstAmount.add(item.sgstAmount).add(item.igstAmount);
      let taxable: Prisma.Decimal;
      let tax: Prisma.Decimal;
      if (qty.eq(remaining)) {
        // The last credit on a line takes exactly what is left, so credits never drift from the invoice.
        const prev = previous.filter((p) => p.invoiceItemId === item.id);
        taxable = item.taxableAmount.sub(prev.reduce((a, p) => a.add(p.taxableAmount), ZERO));
        tax = itemTax.sub(prev.reduce((a, p) => a.add(p.taxAmount), ZERO));
      } else {
        taxable = money(item.taxableAmount.mul(qty).div(item.quantity));
        tax = money(itemTax.mul(qty).div(item.quantity));
      }
      const igst = item.igstAmount.gt(0) ? tax : ZERO;
      const cgst = igst.gt(0) ? ZERO : tax.div(2).toDecimalPlaces(2, Dec.ROUND_DOWN);
      const sgst = igst.gt(0) ? ZERO : tax.sub(cgst);
      return { invoiceItemId: item.id, quantity: qty, taxableAmount: taxable, taxAmount: tax, lineTotal: taxable.add(tax), cgst, sgst, igst };
    });
    const sum = (f: (r: (typeof rows)[number]) => Prisma.Decimal) => rows.reduce((a, r) => a.add(f(r)), ZERO);
    const total = sum((r) => r.lineTotal);
    if (total.lte(0)) throw Errors.unprocessable('NOTHING_TO_CREDIT', 'The selected lines have no value to credit');

    const settings = await branchBilling(tx, actor.organizationId, inv.branchId);
    const fy = financialYear();
    const prefix = `${settings.invoicePrefix}-CN`;
    const { sequenceId, value } = await nextNumber(tx, { organizationId: actor.organizationId, branchId: inv.branchId, type: 'CREDIT_NOTE', prefix, period: fy });
    const cn = await tx.creditNote.create({
      data: {
        organizationId: actor.organizationId,
        branchId: inv.branchId,
        invoiceId: inv.id,
        sequenceId,
        creditNoteNumber: `${prefix}/${fy}/${value}`,
        reason: reason.trim(),
        taxableAmount: sum((r) => r.taxableAmount),
        cgstAmount: sum((r) => r.cgst),
        sgstAmount: sum((r) => r.sgst),
        igstAmount: sum((r) => r.igst),
        totalAmount: total,
        createdById: actor.userId,
        items: {
          create: rows.map((r) => ({ invoiceItemId: r.invoiceItemId, quantity: r.quantity, taxableAmount: r.taxableAmount, taxAmount: r.taxAmount, lineTotal: r.lineTotal })),
        },
      },
    });
    const s = await syncSettlement(tx, inv.id);
    await this.audit.record(
      {
        organizationId: actor.organizationId,
        branchId: inv.branchId,
        actorUserId: actor.userId,
        action: 'credit_note.issued',
        entityType: 'credit_note',
        entityId: cn.id,
        after: { creditNoteNumber: cn.creditNoteNumber, invoiceNumber: inv.invoiceNumber, total, reason, lines, refundDue: s.refundDue },
        meta,
      },
      tx,
    );
    return cn;
  }

  private async lockInvoice(tx: Tx, actor: AuthPrincipal, id: string, permissions: string[]) {
    await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${id}::uuid AND organization_id = ${actor.organizationId}::uuid FOR UPDATE`;
    const inv = await tx.invoice.findFirst({ where: { id, organizationId: actor.organizationId }, include: { items: { orderBy: { lineNo: 'asc' } } } });
    if (!inv) throw Errors.notFound('Invoice');
    requireInBranch(actor, inv.branchId, ['invoices.read', ...permissions], 'Invoice');
    return inv;
  }
}

/** Invoice view with settlement figures and the GST summary by rate printed on the bill. */
function present(inv: InvoiceRow, credit: Awaited<ReturnType<typeof creditPosition>>) {
  const s = settlement(inv, credit.credited, credit.fullyCredited);
  const summary = new Map<string, { rate: Prisma.Decimal; taxableAmount: Prisma.Decimal; cgstAmount: Prisma.Decimal; sgstAmount: Prisma.Decimal; igstAmount: Prisma.Decimal }>();
  for (const i of inv.items) {
    const rate = i.cgstRate.add(i.sgstRate).add(i.igstRate);
    const k = rate.toString();
    const row = summary.get(k) ?? { rate, taxableAmount: ZERO, cgstAmount: ZERO, sgstAmount: ZERO, igstAmount: ZERO };
    summary.set(k, {
      rate,
      taxableAmount: row.taxableAmount.add(i.taxableAmount),
      cgstAmount: row.cgstAmount.add(i.cgstAmount),
      sgstAmount: row.sgstAmount.add(i.sgstAmount),
      igstAmount: row.igstAmount.add(i.igstAmount),
    });
  }
  const { allocations, ...rest } = inv;
  return {
    ...rest,
    payments: allocations.map((a) => ({ ...a.payment, allocated: a.amount })),
    taxSummary: [...summary.values()].sort((a, b) => a.rate.cmp(b.rate)),
    creditedAmount: credit.credited,
    due: s.due,
    netPaid: s.netPaid,
    outstanding: s.outstanding,
    refundDue: s.refundDue,
  };
}
