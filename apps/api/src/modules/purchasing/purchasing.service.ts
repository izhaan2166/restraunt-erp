import { Injectable } from '@nestjs/common';
import { Prisma, PurchaseOrderStatus, SupplierInvoiceStatus } from '@prisma/client';
import { requireInBranch } from '../../common/auth/branch-access';
import { Paginated } from '../../common/dto/pagination';
import { Errors } from '../../common/errors/app-error';
import type { RequestMeta } from '../../common/http/request-meta';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthPrincipal } from '../auth/principal';
import { postMovement } from '../inventory/stock';
import { UnitLike, money2, pricePerBase, qty3, toBase } from '../inventory/units';
import { branchBilling } from '../orders/order-pricing';
import { financialYear, istDay, nextNumber } from '../sequences/sequences';
import {
  CreatePurchaseOrderDto,
  CreateSupplierInvoiceDto,
  DirectReceiptDto,
  ListPurchaseOrdersQuery,
  ListReceiptsQuery,
  ListSupplierInvoicesQuery,
  ListSupplierPaymentsQuery,
  ListSuppliersQuery,
  PoLineDto,
  ReceivePurchaseOrderDto,
  SupplierDto,
  SupplierHistoryQuery,
  SupplierPaymentDto,
  UpdatePurchaseOrderDto,
  UpdateSupplierDto,
} from './dto/purchasing.dto';

type Tx = Prisma.TransactionClient;
type D = Prisma.Decimal;
const Dec = Prisma.Decimal;
const ZERO = new Dec(0);

/** Orders still waiting for (part of) their delivery. */
const OPEN_PO: PurchaseOrderStatus[] = ['DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED'];
const RECEIVABLE: PurchaseOrderStatus[] = ['ORDERED', 'PARTIALLY_RECEIVED'];
const UNPAID: SupplierInvoiceStatus[] = ['UNPAID', 'PARTIALLY_PAID'];

const PO_INCLUDE = {
  supplier: { select: { id: true, name: true, gstin: true } },
  items: { orderBy: { lineNo: 'asc' }, include: { ingredient: { select: { id: true, name: true } }, unit: { select: { code: true } } } },
} satisfies Prisma.PurchaseOrderInclude;

const GRN_INCLUDE = {
  supplier: { select: { id: true, name: true } },
  purchaseOrder: { select: { id: true, poNumber: true } },
  items: { include: { ingredient: { select: { id: true, name: true } }, unit: { select: { code: true } } } },
} satisfies Prisma.GoodsReceiptInclude;

/** Today's date in India, as the midnight-UTC value Postgres `date` columns use. */
function today(): Date {
  const d = istDay();
  return new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00Z`);
}
const asDate = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00Z`);

interface PricedLine {
  ingredientId: string;
  ingredientName: string;
  unit: UnitLike;
  base: UnitLike;
  quantity: D;
  unitPrice: D;
  taxRate: D;
  subtotal: D;
  tax: D;
}

@Injectable()
export class PurchasingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ───────────── Suppliers ─────────────

  async listSuppliers(actor: AuthPrincipal, q: ListSuppliersQuery) {
    const where: Prisma.SupplierWhereInput = {
      organizationId: actor.organizationId,
      deletedAt: null,
      isActive: q.includeInactive ? undefined : true,
      ...(q.search ? { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { gstin: { contains: q.search, mode: 'insensitive' } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.supplier.findMany({ where, orderBy: { name: q.order }, skip: q.skip, take: q.pageSize }),
      this.prisma.supplier.count({ where }),
    ]);
    const dues = await this.dues(actor, rows.map((r) => r.id));
    return new Paginated(
      rows.map((r) => ({ ...r, ...(dues.get(r.id) ?? { outstanding: ZERO, overdue: ZERO }) })),
      total,
      q,
    );
  }

  async getSupplier(actor: AuthPrincipal, id: string) {
    const s = await this.supplierOrThrow(this.prisma, actor.organizationId, id);
    const dues = await this.dues(actor, [id]);
    return { ...s, ...(dues.get(id) ?? { outstanding: ZERO, overdue: ZERO }) };
  }

  async createSupplier(actor: AuthPrincipal, dto: SupplierDto, meta: RequestMeta) {
    return this.prisma.$transaction(async (tx) => {
      const name = dto.name.trim();
      await this.assertSupplierName(tx, actor.organizationId, name);
      const s = await tx.supplier.create({
        data: {
          organizationId: actor.organizationId,
          name,
          contactPerson: dto.contactPerson?.trim() || null,
          phone: dto.phone ?? null,
          email: dto.email ?? null,
          gstin: dto.gstin ?? null,
          stateCode: dto.stateCode ?? dto.gstin?.slice(0, 2) ?? null,
          address: dto.address?.trim() || null,
          paymentTermsDays: dto.paymentTermsDays ?? 0,
        },
      });
      await this.log(tx, actor, null, 'supplier.created', 'supplier', s.id, undefined, s, meta);
      return s;
    });
  }

  async updateSupplier(actor: AuthPrincipal, id: string, dto: UpdateSupplierDto, meta: RequestMeta) {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.supplierOrThrow(tx, actor.organizationId, id);
      const name = dto.name?.trim();
      if (name && name.toLowerCase() !== before.name.toLowerCase()) await this.assertSupplierName(tx, actor.organizationId, name);
      const after = await tx.supplier.update({
        where: { id },
        data: {
          name,
          contactPerson: dto.contactPerson?.trim(),
          phone: dto.phone,
          email: dto.email,
          gstin: dto.gstin,
          stateCode: dto.stateCode ?? (dto.gstin ? dto.gstin.slice(0, 2) : undefined),
          address: dto.address?.trim(),
          paymentTermsDays: dto.paymentTermsDays,
          isActive: dto.isActive,
        },
      });
      await this.log(tx, actor, null, 'supplier.updated', 'supplier', id, before, after, meta);
      return after;
    });
  }

  async deleteSupplier(actor: AuthPrincipal, id: string, meta: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      const s = await this.supplierOrThrow(tx, actor.organizationId, id);
      const [openPos, unpaid] = await Promise.all([
        tx.purchaseOrder.count({ where: { supplierId: id, status: { in: OPEN_PO } } }),
        tx.supplierInvoice.count({ where: { supplierId: id, status: { in: UNPAID } } }),
      ]);
      if (openPos || unpaid) {
        throw Errors.conflict('SUPPLIER_IN_USE', 'This supplier has open purchase orders or unpaid invoices; close them first or mark the supplier inactive', {
          openPurchaseOrders: openPos,
          unpaidInvoices: unpaid,
        });
      }
      await tx.supplier.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
      await this.log(tx, actor, null, 'supplier.deleted', 'supplier', id, s, undefined, meta);
    });
  }

  /**
   * The supplier's account: invoices (amount owed) and payments (amount paid) in date order with
   * a running balance. Covers the branches whose purchases the caller may see.
   */
  async supplierTransactions(actor: AuthPrincipal, id: string, q: SupplierHistoryQuery) {
    const supplier = await this.supplierOrThrow(this.prisma, actor.organizationId, id);
    const branches = this.branchFilter(actor, q.branchId);
    const branchWhere = branches === 'ALL' ? {} : { branchId: { in: branches } };
    const [invoices, payments] = await Promise.all([
      this.prisma.supplierInvoice.findMany({ where: { supplierId: id, status: { not: 'CANCELLED' }, ...branchWhere } }),
      this.prisma.supplierPayment.findMany({ where: { supplierId: id, ...branchWhere }, include: { supplierInvoice: { select: { invoiceNumber: true } } } }),
    ]);
    const entries = [
      ...invoices.map((i) => ({
        date: i.invoiceDate,
        at: i.createdAt,
        type: 'INVOICE' as const,
        id: i.id,
        branchId: i.branchId,
        reference: i.invoiceNumber,
        debit: i.total,
        credit: ZERO,
      })),
      ...payments.map((p) => ({
        date: p.paidAt,
        at: p.paidAt,
        type: 'PAYMENT' as const,
        id: p.id,
        branchId: p.branchId,
        reference: p.reference ?? p.supplierInvoice?.invoiceNumber ?? null,
        method: p.method,
        debit: ZERO,
        credit: p.amount,
      })),
    ].sort((a, b) => a.date.getTime() - b.date.getTime() || a.at.getTime() - b.at.getTime());
    let balance = ZERO;
    const rows = entries.map(({ at: _at, ...e }) => {
      balance = balance.add(e.debit).sub(e.credit);
      return { ...e, balance };
    });
    return { supplier: { id: supplier.id, name: supplier.name }, entries: rows, balance };
  }

  // ───────────── Purchase orders ─────────────

  async createPurchaseOrder(actor: AuthPrincipal, dto: CreatePurchaseOrderDto, meta: RequestMeta) {
    return this.prisma.$transaction(async (tx) => {
      const supplier = await this.supplierOrThrow(tx, actor.organizationId, dto.supplierId);
      if (!supplier.isActive) throw Errors.unprocessable('SUPPLIER_INACTIVE', `${supplier.name} is inactive`);
      const lines = await this.priceLines(tx, actor.organizationId, dto.items);
      const settings = await branchBilling(tx, actor.organizationId, dto.branchId);
      const fy = financialYear();
      const prefix = `${settings.invoicePrefix}-PO`;
      const { value } = await nextNumber(tx, { organizationId: actor.organizationId, branchId: dto.branchId, type: 'PURCHASE_ORDER', prefix, period: fy });
      const po = await tx.purchaseOrder.create({
        data: {
          organizationId: actor.organizationId,
          branchId: dto.branchId,
          supplierId: supplier.id,
          poNumber: `${prefix}/${fy}/${value}`,
          expectedDate: dto.expectedDate ? new Date(dto.expectedDate) : null,
          notes: dto.notes?.trim() || null,
          createdById: actor.userId,
          ...this.totals(lines),
          items: { create: this.itemRows(lines) },
        },
        include: PO_INCLUDE,
      });
      await this.log(tx, actor, dto.branchId, 'purchase_order.created', 'purchase_order', po.id, undefined, { poNumber: po.poNumber, supplier: supplier.name, total: po.total }, meta);
      return this.withRemaining(po);
    });
  }

  async listPurchaseOrders(actor: AuthPrincipal, q: ListPurchaseOrdersQuery) {
    const status = q.pending ? (q.status?.filter((s) => RECEIVABLE.includes(s)) ?? RECEIVABLE) : q.status;
    const where: Prisma.PurchaseOrderWhereInput = {
      organizationId: actor.organizationId,
      branchId: q.branchId,
      supplierId: q.supplierId,
      ...(status ? { status: { in: status } } : {}),
      ...(q.search ? { poNumber: { contains: q.search, mode: 'insensitive' } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.purchaseOrder.findMany({ where, include: PO_INCLUDE, orderBy: { createdAt: q.order }, skip: q.skip, take: q.pageSize }),
      this.prisma.purchaseOrder.count({ where }),
    ]);
    return new Paginated(rows.map((r) => this.withRemaining(r)), total, q);
  }

  async getPurchaseOrder(actor: AuthPrincipal, id: string) {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, organizationId: actor.organizationId },
      include: { ...PO_INCLUDE, receipts: { orderBy: { receivedAt: 'asc' }, select: { id: true, grnNumber: true, receivedAt: true } } },
    });
    if (!po) throw Errors.notFound('Purchase order');
    requireInBranch(actor, po.branchId, ['purchases.read'], 'Purchase order');
    return this.withRemaining(po);
  }

  async updatePurchaseOrder(actor: AuthPrincipal, id: string, dto: UpdatePurchaseOrderDto, meta: RequestMeta) {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.lockPo(tx, actor, id, ['purchases.create']);
      if (before.status !== 'DRAFT') throw Errors.conflict('PO_NOT_EDITABLE', 'Only a draft purchase order can be changed');
      let lineData = {};
      if (dto.items) {
        const lines = await this.priceLines(tx, actor.organizationId, dto.items);
        await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: id } });
        lineData = { ...this.totals(lines), items: { create: this.itemRows(lines) } };
      }
      const po = await tx.purchaseOrder.update({
        where: { id },
        data: {
          expectedDate: dto.expectedDate === undefined ? undefined : new Date(dto.expectedDate),
          notes: dto.notes === undefined ? undefined : dto.notes.trim() || null,
          ...lineData,
        },
        include: PO_INCLUDE,
      });
      await this.log(tx, actor, po.branchId, 'purchase_order.updated', 'purchase_order', id, { total: before.total }, { total: po.total, lines: po.items.length }, meta);
      return this.withRemaining(po);
    });
  }

  /** Approving a draft places the order with the supplier; goods can be received from then on. */
  async approvePurchaseOrder(actor: AuthPrincipal, id: string, meta: RequestMeta) {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.lockPo(tx, actor, id, ['purchases.approve']);
      if (before.status !== 'DRAFT') throw Errors.conflict('PO_NOT_DRAFT', 'Only a draft purchase order can be approved');
      const po = await tx.purchaseOrder.update({ where: { id }, data: { status: 'ORDERED', approvedById: actor.userId, orderDate: new Date() }, include: PO_INCLUDE });
      await this.log(tx, actor, po.branchId, 'purchase_order.approved', 'purchase_order', id, { status: before.status }, { status: po.status }, meta);
      return this.withRemaining(po);
    });
  }

  /**
   * Cancels what is still to come. A draft can be cancelled by whoever can create orders; an
   * approved order needs approval rights. Goods already received stay in stock and on record.
   */
  async cancelPurchaseOrder(actor: AuthPrincipal, id: string, reason: string, meta: RequestMeta) {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.lockPo(tx, actor, id, ['purchases.create']);
      if (!OPEN_PO.includes(before.status)) throw Errors.conflict('PO_NOT_CANCELLABLE', `A ${before.status.toLowerCase()} purchase order cannot be cancelled`);
      if (before.status !== 'DRAFT') requireInBranch(actor, before.branchId, ['purchases.approve'], 'Purchase order');
      const po = await tx.purchaseOrder.update({ where: { id }, data: { status: 'CANCELLED', cancelReason: reason.trim() }, include: PO_INCLUDE });
      await this.log(tx, actor, po.branchId, 'purchase_order.cancelled', 'purchase_order', id, { status: before.status }, { status: po.status, reason: po.cancelReason }, meta);
      return this.withRemaining(po);
    });
  }

  // ───────────── Goods received ─────────────

  /**
   * Records a delivery against an approved order. Deliveries can be partial; receiving more than
   * was ordered is refused. Each line adds stock at its purchase price (before GST, which is
   * claimed back as input tax credit) and updates the average cost.
   */
  async receive(actor: AuthPrincipal, poId: string, dto: ReceivePurchaseOrderDto, meta: RequestMeta) {
    return this.prisma.$transaction(async (tx) => {
      const po = await this.lockPo(tx, actor, poId, ['purchases.receive']);
      if (!RECEIVABLE.includes(po.status)) {
        throw Errors.conflict('PO_NOT_RECEIVABLE', po.status === 'DRAFT' ? 'Approve the purchase order before receiving goods' : `This purchase order is ${po.status.toLowerCase()}`);
      }
      const items = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId: poId }, include: { unit: true, ingredient: { include: { baseUnit: true } } } });
      const seen = new Set<string>();
      const lines = dto.items.map((l) => {
        const item = items.find((i) => i.id === l.purchaseOrderItemId);
        if (!item) throw Errors.badRequest('INVALID_PO_ITEM', 'The line does not belong to this purchase order', { purchaseOrderItemId: l.purchaseOrderItemId });
        if (seen.has(item.id)) throw Errors.badRequest('DUPLICATE_LINE', 'Each order line can appear once per delivery', { purchaseOrderItemId: item.id });
        seen.add(item.id);
        const quantity = qty3(new Dec(l.quantity));
        if (quantity.lte(0)) throw Errors.badRequest('INVALID_QUANTITY', 'quantity must be greater than 0');
        const remaining = item.quantity.sub(item.receivedQuantity);
        if (quantity.gt(remaining)) {
          throw Errors.conflict('OVER_RECEIPT', `Only ${remaining.toString()} ${item.unit.code} of ${item.ingredient.name} is still due on this order`, {
            purchaseOrderItemId: item.id,
            ordered: item.quantity.toString(),
            received: item.receivedQuantity.toString(),
            remaining: remaining.toString(),
          });
        }
        return {
          purchaseOrderItemId: item.id,
          ingredientId: item.ingredientId,
          ingredientName: item.ingredient.name,
          unit: item.unit,
          base: item.ingredient.baseUnit,
          quantity,
          unitPrice: l.unitPrice ? new Dec(l.unitPrice) : item.unitPrice,
        };
      });

      const grn = await this.createReceipt(tx, actor, { branchId: po.branchId, supplierId: po.supplierId, purchaseOrderId: po.id, notes: dto.notes }, lines);
      for (const l of lines) {
        await tx.purchaseOrderItem.update({ where: { id: l.purchaseOrderItemId }, data: { receivedQuantity: { increment: l.quantity } } });
      }
      const after = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId: poId }, select: { quantity: true, receivedQuantity: true } });
      const status: PurchaseOrderStatus = after.every((i) => i.receivedQuantity.gte(i.quantity)) ? 'RECEIVED' : 'PARTIALLY_RECEIVED';
      await tx.purchaseOrder.update({ where: { id: poId }, data: { status } });
      await this.log(tx, actor, po.branchId, 'goods_receipt.created', 'goods_receipt', grn.id, undefined, { grnNumber: grn.grnNumber, poNumber: po.poNumber, poStatus: status, lines: lines.length }, meta);
      return { ...grn, purchaseOrderStatus: status };
    });
  }

  /** Goods bought without a purchase order (a market run, an urgent top-up). */
  async directReceipt(actor: AuthPrincipal, dto: DirectReceiptDto, meta: RequestMeta) {
    return this.prisma.$transaction(async (tx) => {
      const supplier = await this.supplierOrThrow(tx, actor.organizationId, dto.supplierId);
      if (!supplier.isActive) throw Errors.unprocessable('SUPPLIER_INACTIVE', `${supplier.name} is inactive`);
      await branchBilling(tx, actor.organizationId, dto.branchId);
      const priced = await this.priceLines(tx, actor.organizationId, dto.items.map((i) => ({ ...i, taxRate: '0' })));
      const grn = await this.createReceipt(tx, actor, { branchId: dto.branchId, supplierId: supplier.id, purchaseOrderId: null, notes: dto.notes }, priced);
      await this.log(tx, actor, dto.branchId, 'goods_receipt.created', 'goods_receipt', grn.id, undefined, { grnNumber: grn.grnNumber, supplier: supplier.name, lines: priced.length }, meta);
      return grn;
    });
  }

  async listReceipts(actor: AuthPrincipal, q: ListReceiptsQuery) {
    const where: Prisma.GoodsReceiptWhereInput = {
      organizationId: actor.organizationId,
      branchId: q.branchId,
      supplierId: q.supplierId,
      purchaseOrderId: q.purchaseOrderId,
      ...(q.search ? { grnNumber: { contains: q.search, mode: 'insensitive' } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.goodsReceipt.findMany({ where, include: GRN_INCLUDE, orderBy: { receivedAt: q.order }, skip: q.skip, take: q.pageSize }),
      this.prisma.goodsReceipt.count({ where }),
    ]);
    return new Paginated(rows.map((r) => this.withValue(r)), total, q);
  }

  async getReceipt(actor: AuthPrincipal, id: string) {
    const grn = await this.prisma.goodsReceipt.findFirst({ where: { id, organizationId: actor.organizationId }, include: GRN_INCLUDE });
    if (!grn) throw Errors.notFound('Goods receipt');
    requireInBranch(actor, grn.branchId, ['purchases.read'], 'Goods receipt');
    return this.withValue(grn);
  }

  // ───────────── Supplier invoices ─────────────

  async createInvoice(actor: AuthPrincipal, dto: CreateSupplierInvoiceDto, meta: RequestMeta) {
    return this.prisma.$transaction(async (tx) => {
      const supplier = await this.supplierOrThrow(tx, actor.organizationId, dto.supplierId);
      await branchBilling(tx, actor.organizationId, dto.branchId);
      const invoiceNumber = dto.invoiceNumber.trim();
      const dup = await tx.supplierInvoice.findUnique({ where: { supplierId_invoiceNumber: { supplierId: supplier.id, invoiceNumber } } });
      if (dup) throw Errors.conflict('DUPLICATE_SUPPLIER_INVOICE', `Invoice ${invoiceNumber} from ${supplier.name} is already recorded`, { supplierInvoiceId: dup.id });

      if (dto.purchaseOrderId) {
        const po = await tx.purchaseOrder.findFirst({ where: { id: dto.purchaseOrderId, organizationId: actor.organizationId } });
        if (!po || po.branchId !== dto.branchId || po.supplierId !== supplier.id) {
          throw Errors.badRequest('INVALID_PURCHASE_ORDER', 'The purchase order must be from this supplier and branch');
        }
      }
      const grnIds = [...new Set(dto.goodsReceiptIds ?? [])];
      if (grnIds.length) {
        const grns = await tx.goodsReceipt.findMany({ where: { id: { in: grnIds }, organizationId: actor.organizationId } });
        const bad = grnIds.filter((id) => {
          const g = grns.find((r) => r.id === id);
          return !g || g.branchId !== dto.branchId || g.supplierId !== supplier.id;
        });
        if (bad.length) throw Errors.badRequest('INVALID_GOODS_RECEIPT', 'Goods receipts must be from this supplier and branch', { goodsReceiptIds: bad });
        const billed = grns.filter((g) => g.supplierInvoiceId);
        if (billed.length) throw Errors.conflict('GRN_ALREADY_INVOICED', 'Some goods receipts are already on another invoice', { goodsReceiptIds: billed.map((g) => g.id) });
      }

      const subtotal = new Dec(dto.subtotal);
      const taxTotal = new Dec(dto.taxTotal);
      const total = money2(subtotal.add(taxTotal));
      if (total.lte(0)) throw Errors.badRequest('INVALID_AMOUNT', 'The invoice total must be greater than 0');
      const invoiceDate = asDate(dto.invoiceDate);
      const dueDate = dto.dueDate ? asDate(dto.dueDate) : new Date(invoiceDate.getTime() + supplier.paymentTermsDays * 86_400_000);
      if (dueDate < invoiceDate) throw Errors.badRequest('INVALID_DUE_DATE', 'The due date cannot be before the invoice date');

      const inv = await tx.supplierInvoice.create({
        data: {
          organizationId: actor.organizationId,
          branchId: dto.branchId,
          supplierId: supplier.id,
          purchaseOrderId: dto.purchaseOrderId ?? null,
          invoiceNumber,
          invoiceDate,
          dueDate,
          subtotal,
          taxTotal,
          total,
          createdById: actor.userId,
        },
      });
      if (grnIds.length) {
        const linked = await tx.goodsReceipt.updateMany({ where: { id: { in: grnIds }, supplierInvoiceId: null }, data: { supplierInvoiceId: inv.id } });
        if (linked.count !== grnIds.length) throw Errors.conflict('GRN_ALREADY_INVOICED', 'Some goods receipts are already on another invoice');
      }
      await this.log(tx, actor, dto.branchId, 'supplier_invoice.created', 'supplier_invoice', inv.id, undefined, { supplier: supplier.name, invoiceNumber, total, goodsReceipts: grnIds.length }, meta);
      return this.getInvoiceTx(tx, inv.id);
    });
  }

  async listInvoices(actor: AuthPrincipal, q: ListSupplierInvoicesQuery) {
    const where: Prisma.SupplierInvoiceWhereInput = {
      organizationId: actor.organizationId,
      branchId: q.branchId,
      supplierId: q.supplierId,
      ...(q.overdue ? { status: { in: q.status?.filter((s) => UNPAID.includes(s)) ?? UNPAID }, dueDate: { lt: today() } } : q.status ? { status: { in: q.status } } : {}),
      ...(q.search ? { invoiceNumber: { contains: q.search, mode: 'insensitive' } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.supplierInvoice.findMany({ where, include: { supplier: { select: { id: true, name: true } } }, orderBy: [{ invoiceDate: q.order }, { createdAt: q.order }], skip: q.skip, take: q.pageSize }),
      this.prisma.supplierInvoice.count({ where }),
    ]);
    return new Paginated(rows.map((r) => this.withOutstanding(r)), total, q);
  }

  async getInvoice(actor: AuthPrincipal, id: string) {
    const inv = await this.prisma.supplierInvoice.findFirst({ where: { id, organizationId: actor.organizationId }, select: { branchId: true } });
    if (!inv) throw Errors.notFound('Supplier invoice');
    requireInBranch(actor, inv.branchId, ['purchases.read'], 'Supplier invoice');
    return this.getInvoiceTx(this.prisma, id);
  }

  /** Only an invoice with nothing paid against it can be cancelled; its goods receipts are freed. */
  async cancelInvoice(actor: AuthPrincipal, id: string, reason: string, meta: RequestMeta) {
    return this.prisma.$transaction(async (tx) => {
      const inv = await this.lockInvoice(tx, actor, id);
      if (inv.status === 'CANCELLED') throw Errors.conflict('INVOICE_CANCELLED', 'This invoice is already cancelled');
      if (inv.paidAmount.gt(0)) throw Errors.conflict('INVOICE_HAS_PAYMENTS', 'An invoice with payments recorded cannot be cancelled');
      await tx.goodsReceipt.updateMany({ where: { supplierInvoiceId: id }, data: { supplierInvoiceId: null } });
      await tx.supplierInvoice.update({ where: { id }, data: { status: 'CANCELLED' } });
      await this.log(tx, actor, inv.branchId, 'supplier_invoice.cancelled', 'supplier_invoice', id, { status: inv.status }, { status: 'CANCELLED', reason: reason.trim() }, meta);
      return this.getInvoiceTx(tx, id);
    });
  }

  // ───────────── Supplier payments ─────────────

  async pay(actor: AuthPrincipal, dto: SupplierPaymentDto, idempotencyKey: string | null, meta: RequestMeta) {
    return this.prisma.$transaction(async (tx) => {
      const inv = await this.lockInvoice(tx, actor, dto.supplierInvoiceId);
      if (inv.status === 'CANCELLED' || inv.status === 'PAID') {
        throw Errors.conflict('INVOICE_NOT_PAYABLE', inv.status === 'PAID' ? 'This invoice is already fully paid' : 'This invoice is cancelled');
      }
      const amount = new Dec(dto.amount);
      const outstanding = inv.total.sub(inv.paidAmount);
      if (amount.lte(0)) throw Errors.badRequest('INVALID_AMOUNT', 'amount must be greater than 0');
      if (amount.gt(outstanding)) {
        throw Errors.unprocessable('AMOUNT_EXCEEDS_OUTSTANDING', `Only ₹${outstanding.toFixed(2)} is outstanding on this invoice`, { outstanding: outstanding.toFixed(2) });
      }
      const payment = await tx.supplierPayment.create({
        data: {
          organizationId: actor.organizationId,
          branchId: inv.branchId,
          supplierId: inv.supplierId,
          supplierInvoiceId: inv.id,
          amount,
          method: dto.method,
          reference: dto.reference?.trim() || null,
          idempotencyKey,
          paidById: actor.userId,
        },
      });
      const paidAmount = inv.paidAmount.add(amount);
      const status: SupplierInvoiceStatus = paidAmount.gte(inv.total) ? 'PAID' : 'PARTIALLY_PAID';
      await tx.supplierInvoice.update({ where: { id: inv.id }, data: { paidAmount, status } });
      await this.log(tx, actor, inv.branchId, 'supplier_payment.created', 'supplier_payment', payment.id, undefined, { invoiceNumber: inv.invoiceNumber, amount, method: dto.method, invoiceStatus: status }, meta);
      return { payment, invoice: this.withOutstanding({ ...inv, paidAmount, status }) };
    });
  }

  async listPayments(actor: AuthPrincipal, q: ListSupplierPaymentsQuery) {
    const where: Prisma.SupplierPaymentWhereInput = { organizationId: actor.organizationId, branchId: q.branchId, supplierId: q.supplierId };
    const [rows, total] = await Promise.all([
      this.prisma.supplierPayment.findMany({
        where,
        include: { supplier: { select: { id: true, name: true } }, supplierInvoice: { select: { id: true, invoiceNumber: true } } },
        orderBy: { paidAt: q.order },
        skip: q.skip,
        take: q.pageSize,
      }),
      this.prisma.supplierPayment.count({ where }),
    ]);
    return new Paginated(rows, total, q);
  }

  // ───────────── Helpers ─────────────

  private async createReceipt(
    tx: Tx,
    actor: AuthPrincipal,
    head: { branchId: string; supplierId: string; purchaseOrderId: string | null; notes?: string },
    lines: { purchaseOrderItemId?: string; ingredientId: string; ingredientName: string; unit: UnitLike; base: UnitLike; quantity: D; unitPrice: D }[],
  ) {
    const settings = await branchBilling(tx, actor.organizationId, head.branchId);
    const fy = financialYear();
    const prefix = `${settings.invoicePrefix}-GRN`;
    const { value } = await nextNumber(tx, { organizationId: actor.organizationId, branchId: head.branchId, type: 'GOODS_RECEIPT', prefix, period: fy });
    const grn = await tx.goodsReceipt.create({
      data: {
        organizationId: actor.organizationId,
        branchId: head.branchId,
        supplierId: head.supplierId,
        purchaseOrderId: head.purchaseOrderId,
        grnNumber: `${prefix}/${fy}/${value}`,
        notes: head.notes?.trim() || null,
        receivedById: actor.userId,
      },
    });
    for (const l of lines) {
      const baseQuantity = qty3(toBase(l.quantity, l.unit, l.base));
      if (baseQuantity.lte(0)) throw Errors.badRequest('INVALID_QUANTITY', `The quantity of ${l.ingredientName} is too small to record`);
      const item = await tx.goodsReceiptItem.create({
        data: {
          goodsReceiptId: grn.id,
          purchaseOrderItemId: l.purchaseOrderItemId ?? null,
          ingredientId: l.ingredientId,
          unitId: l.unit.id,
          quantity: l.quantity,
          baseQuantity,
          unitPrice: l.unitPrice,
        },
      });
      await postMovement(tx, {
        organizationId: actor.organizationId,
        branchId: head.branchId,
        ingredientId: l.ingredientId,
        type: 'PURCHASE_RECEIPT',
        quantity: baseQuantity,
        unitCost: pricePerBase(l.unitPrice, l.unit, l.base),
        referenceType: 'goods_receipt',
        referenceId: grn.id,
        dedupeKey: `grn_item:${item.id}`,
        note: grn.grnNumber,
        userId: actor.userId,
      });
    }
    const full = await tx.goodsReceipt.findUniqueOrThrow({ where: { id: grn.id }, include: GRN_INCLUDE });
    return this.withValue(full);
  }

  /** Validates ingredients and units of order lines and works out each line's amounts. */
  private async priceLines(tx: Tx, organizationId: string, items: PoLineDto[]): Promise<PricedLine[]> {
    const ids = [...new Set(items.map((i) => i.ingredientId))];
    const ingredients = await tx.ingredient.findMany({ where: { id: { in: ids }, organizationId, deletedAt: null }, include: { baseUnit: true } });
    const missing = ids.filter((id) => !ingredients.some((r) => r.id === id));
    if (missing.length) throw Errors.badRequest('INVALID_INGREDIENT', 'Unknown ingredient(s)', { missing });
    const units = await tx.unit.findMany({ where: { code: { in: [...new Set(items.map((i) => i.unit))] } } });
    return items.map((i) => {
      const ing = ingredients.find((r) => r.id === i.ingredientId)!;
      if (!ing.isActive) throw Errors.unprocessable('INGREDIENT_INACTIVE', `${ing.name} is inactive`);
      const unit = units.find((u) => u.code === i.unit);
      if (!unit) throw Errors.badRequest('INVALID_UNIT', `Unknown unit "${i.unit}"`);
      toBase(new Dec(1), unit, ing.baseUnit); // refuses kg for an ingredient counted in pieces
      const quantity = qty3(new Dec(i.quantity));
      if (quantity.lte(0)) throw Errors.badRequest('INVALID_QUANTITY', 'quantity must be greater than 0');
      const unitPrice = new Dec(i.unitPrice);
      const taxRate = new Dec(i.taxRate ?? 0);
      const subtotal = money2(quantity.mul(unitPrice));
      const tax = money2(subtotal.mul(taxRate).div(100));
      return { ingredientId: ing.id, ingredientName: ing.name, unit, base: ing.baseUnit, quantity, unitPrice, taxRate, subtotal, tax };
    });
  }

  private totals(lines: PricedLine[]) {
    const subtotal = lines.reduce((a, l) => a.add(l.subtotal), ZERO);
    const taxTotal = lines.reduce((a, l) => a.add(l.tax), ZERO);
    return { subtotal, taxTotal, total: subtotal.add(taxTotal) };
  }

  private itemRows(lines: PricedLine[]) {
    return lines.map((l, n) => ({
      ingredientId: l.ingredientId,
      unitId: l.unit.id,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      taxRate: l.taxRate,
      lineTotal: l.subtotal.add(l.tax),
      lineNo: n + 1,
    }));
  }

  private withRemaining<T extends { items: { quantity: D; receivedQuantity: D }[] }>(po: T) {
    return { ...po, items: po.items.map((i) => ({ ...i, remainingQuantity: Dec.max(i.quantity.sub(i.receivedQuantity), 0) })) };
  }

  private withValue<T extends { items: { quantity: D; unitPrice: D }[] }>(grn: T) {
    return { ...grn, totalValue: grn.items.reduce((a, i) => a.add(money2(i.quantity.mul(i.unitPrice))), ZERO) };
  }

  private withOutstanding<T extends { total: D; paidAmount: D; status: SupplierInvoiceStatus; dueDate: Date | null }>(inv: T) {
    const outstanding = inv.status === 'CANCELLED' ? ZERO : inv.total.sub(inv.paidAmount);
    return { ...inv, outstanding, isOverdue: outstanding.gt(0) && !!inv.dueDate && inv.dueDate < today() };
  }

  private async getInvoiceTx(db: Tx, id: string) {
    const inv = await db.supplierInvoice.findUniqueOrThrow({
      where: { id },
      include: {
        supplier: { select: { id: true, name: true, gstin: true } },
        payments: { orderBy: { paidAt: 'asc' } },
        goodsReceiptsBySupplierInvoice: { select: { id: true, grnNumber: true, receivedAt: true } },
      },
    });
    const { goodsReceiptsBySupplierInvoice: goodsReceipts, ...rest } = inv;
    return this.withOutstanding({ ...rest, goodsReceipts });
  }

  /** Outstanding and overdue amounts per supplier, over the branches whose purchases the caller may see. */
  private async dues(actor: AuthPrincipal, supplierIds: string[]) {
    const out = new Map<string, { outstanding: D; overdue: D }>();
    if (!supplierIds.length) return out;
    const branches = this.branchFilter(actor);
    const base: Prisma.SupplierInvoiceWhereInput = {
      supplierId: { in: supplierIds },
      status: { in: UNPAID },
      ...(branches === 'ALL' ? {} : { branchId: { in: branches } }),
    };
    const [all, late] = await Promise.all([
      this.prisma.supplierInvoice.groupBy({ by: ['supplierId'], where: base, _sum: { total: true, paidAmount: true } }),
      this.prisma.supplierInvoice.groupBy({ by: ['supplierId'], where: { ...base, dueDate: { lt: today() } }, _sum: { total: true, paidAmount: true } }),
    ]);
    const owed = (s: { total: D | null; paidAmount: D | null }) => (s.total ?? ZERO).sub(s.paidAmount ?? ZERO);
    for (const id of supplierIds) {
      const a = all.find((r) => r.supplierId === id);
      const l = late.find((r) => r.supplierId === id);
      out.set(id, { outstanding: a ? owed(a._sum) : ZERO, overdue: l ? owed(l._sum) : ZERO });
    }
    return out;
  }

  /** Branches whose purchase records the caller may read: one asked-for branch, or all of them. */
  private branchFilter(actor: AuthPrincipal, branchId?: string): 'ALL' | string[] {
    if (branchId) {
      requireInBranch(actor, branchId, ['purchases.read'], 'Branch');
      return [branchId];
    }
    const access = actor.permissions.accessibleBranches();
    if (access === 'ALL') return 'ALL';
    return access.filter((b) => actor.permissions.has('purchases.read', b));
  }

  private async lockPo(tx: Tx, actor: AuthPrincipal, id: string, permissions: string[]) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM purchase_orders WHERE id = ${id}::uuid AND organization_id = ${actor.organizationId}::uuid FOR UPDATE`;
    if (!rows.length) throw Errors.notFound('Purchase order');
    const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id } });
    requireInBranch(actor, po.branchId, permissions, 'Purchase order');
    return po;
  }

  private async lockInvoice(tx: Tx, actor: AuthPrincipal, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM supplier_invoices WHERE id = ${id}::uuid AND organization_id = ${actor.organizationId}::uuid FOR UPDATE`;
    if (!rows.length) throw Errors.notFound('Supplier invoice');
    const inv = await tx.supplierInvoice.findUniqueOrThrow({ where: { id } });
    requireInBranch(actor, inv.branchId, ['supplier_payments.create'], 'Supplier invoice');
    return inv;
  }

  private async supplierOrThrow(db: Tx, organizationId: string, id: string) {
    const s = await db.supplier.findFirst({ where: { id, organizationId, deletedAt: null } });
    if (!s) throw Errors.notFound('Supplier');
    return s;
  }

  private async assertSupplierName(tx: Tx, organizationId: string, name: string) {
    const clash = await tx.supplier.findFirst({ where: { organizationId, name: { equals: name, mode: 'insensitive' } } });
    if (clash) throw Errors.conflict('DUPLICATE_NAME', `A supplier named "${clash.name}" already exists${clash.deletedAt ? ' (deleted)' : ''}`);
  }

  private log(tx: Tx, actor: AuthPrincipal, branchId: string | null, action: string, entityType: string, entityId: string, before: unknown, after: unknown, meta: RequestMeta) {
    return this.audit.record({ organizationId: actor.organizationId, branchId, actorUserId: actor.userId, action, entityType, entityId, before, after, meta }, tx);
  }
}
