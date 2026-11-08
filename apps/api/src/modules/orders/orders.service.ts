import { Injectable } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { requireInBranch } from '../../common/auth/branch-access';
import { Paginated } from '../../common/dto/pagination';
import { Errors } from '../../common/errors/app-error';
import type { RequestMeta } from '../../common/http/request-meta';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthPrincipal } from '../auth/principal';
import { istDay, nextNumber } from '../sequences/sequences';
import {
  ApplyDiscountDto,
  ChangeStatusDto,
  CreateOrderDto,
  ListOrdersQuery,
  ReasonDto,
  UpdateOrderDto,
  VersionDto,
} from './dto/orders.dto';
import { EDITABLE_STATUSES, canTransition, isFinal, nextStatuses } from './order-state';
import { branchBilling, buildItems, insertItems, recomputeOrder } from './order-pricing';

type Tx = Prisma.TransactionClient;
const Dec = Prisma.Decimal;

export const ORDER_DETAIL = {
  items: { orderBy: { createdAt: 'asc' }, include: { modifiers: true, ticketItems: { select: { ticketId: true, status: true } } } },
  appliedDiscounts: { orderBy: { createdAt: 'asc' } },
  statusHistory: { orderBy: { createdAt: 'asc' } },
  kitchenTickets: { orderBy: { createdAt: 'asc' }, select: { id: true, ticketNumber: true, status: true, stationId: true, createdAt: true } },
  invoices: { orderBy: { createdAt: 'asc' }, select: { id: true, invoiceNumber: true, status: true, grandTotal: true, paymentStatus: true } },
  tableSession: { select: { id: true, tableId: true, table: { select: { label: true } } } },
} satisfies Prisma.OrderInclude;

/** Orders whose status lets the bill be settled and the order completed. */
const COMPLETABLE: OrderStatus[] = ['SERVED', 'PICKED_UP', 'DELIVERED'];

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ───────────── Read ─────────────

  async list(actor: AuthPrincipal, q: ListOrdersQuery) {
    const where: Prisma.OrderWhereInput = {
      organizationId: actor.organizationId,
      branchId: q.branchId,
      status: q.status?.length ? { in: q.status } : undefined,
      orderType: q.type,
      tableSessionId: q.tableSessionId,
      createdAt: q.from || q.to ? { gte: q.from ? new Date(q.from) : undefined, lte: q.to ? new Date(q.to) : undefined } : undefined,
      ...(q.search
        ? { OR: [{ orderNumber: { contains: q.search } }, { customerName: { contains: q.search, mode: 'insensitive' } }, { customerPhone: { contains: q.search } }] }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: q.order },
        skip: q.skip,
        take: q.pageSize,
        include: { _count: { select: { items: { where: { status: 'ACTIVE' } } } }, tableSession: { select: { table: { select: { label: true } } } } },
      }),
      this.prisma.order.count({ where }),
    ]);
    return new Paginated(rows, total, q);
  }

  async get(actor: AuthPrincipal, id: string, db: Tx | PrismaService = this.prisma) {
    const order = await db.order.findFirst({ where: { id, organizationId: actor.organizationId }, include: ORDER_DETAIL });
    if (!order) throw Errors.notFound('Order');
    requireInBranch(actor, order.branchId, ['orders.read'], 'Order');
    return { ...order, allowedTransitions: nextStatuses(order.orderType, order.status) };
  }

  // ───────────── Create ─────────────

  async create(actor: AuthPrincipal, dto: CreateOrderDto, meta: RequestMeta) {
    if (dto.orderType === 'DINE_IN' && !dto.tableId) throw Errors.badRequest('TABLE_REQUIRED', 'Dine-in orders need an open table');
    if (dto.orderType !== 'DINE_IN' && dto.tableId) throw Errors.badRequest('TABLE_NOT_ALLOWED', 'Only dine-in orders take a table');
    if (dto.orderType === 'DELIVERY' && !dto.deliveryAddress?.trim()) {
      throw Errors.badRequest('DELIVERY_ADDRESS_REQUIRED', 'Delivery orders need an address');
    }

    const id = await this.prisma.$transaction(async (tx) => {
      const settings = await branchBilling(tx, actor.organizationId, dto.branchId);
      let tableSessionId: string | null = null;
      if (dto.tableId) {
        await tx.$queryRaw`SELECT id FROM restaurant_tables WHERE id = ${dto.tableId}::uuid AND branch_id = ${dto.branchId}::uuid FOR UPDATE`;
        const session = await tx.tableSession.findFirst({
          where: { tableId: dto.tableId, branchId: dto.branchId, organizationId: actor.organizationId, closedAt: null, table: { deletedAt: null } },
        });
        if (!session) throw Errors.conflict('TABLE_NOT_OPEN', 'Open the table before taking its order');
        // A table merged into another bills to the main table's session.
        tableSessionId = session.mergedIntoId ?? session.id;
      }
      const items = await buildItems(tx, actor, settings, dto.items);
      const day = istDay();
      const { value } = await nextNumber(tx, { organizationId: actor.organizationId, branchId: dto.branchId, type: 'ORDER', prefix: 'ORD', period: day });
      const order = await tx.order.create({
        data: {
          organizationId: actor.organizationId,
          branchId: dto.branchId,
          orderNumber: `${day}-${String(value).padStart(4, '0')}`,
          orderType: dto.orderType,
          tableSessionId,
          customerName: dto.customerName?.trim() || null,
          customerPhone: dto.customerPhone ?? null,
          deliveryAddress: dto.deliveryAddress?.trim() || null,
          guestCount: dto.guestCount,
          notes: dto.notes?.trim() || null,
          createdById: actor.userId,
        },
      });
      await insertItems(tx, order.id, actor.userId, items);
      await tx.orderStatusHistory.create({ data: { orderId: order.id, toStatus: 'NEW', changedById: actor.userId } });
      const { result } = await recomputeOrder(tx, order.id);
      await this.audit.record(
        {
          organizationId: actor.organizationId,
          branchId: dto.branchId,
          actorUserId: actor.userId,
          action: 'order.created',
          entityType: 'order',
          entityId: order.id,
          after: { orderNumber: order.orderNumber, orderType: order.orderType, items: dto.items, grandTotal: result.grandTotal },
          metadata: priceOverrides(items),
          meta,
        },
        tx,
      );
      return order.id;
    });
    return this.get(actor, id);
  }

  // ───────────── Edit ─────────────

  async update(actor: AuthPrincipal, id: string, dto: UpdateOrderDto, meta: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockForChange(tx, actor, id, ['orders.update'], dto.version);
      if (!EDITABLE_STATUSES.includes(order.status)) throw Errors.unprocessable('ORDER_NOT_EDITABLE', `A ${order.status.toLowerCase()} order cannot be changed`);
      await this.assertNotInvoiced(tx, id);
      const settings = await branchBilling(tx, actor.organizationId, order.branchId);
      const items = await tx.orderItem.findMany({ where: { orderId: id }, include: { ticketItems: { select: { id: true } } } });
      const find = (itemId: string) => {
        const it = items.find((i) => i.id === itemId && i.status === 'ACTIVE');
        if (!it) throw Errors.badRequest('INVALID_ORDER_ITEM', `Item ${itemId} is not an active item of this order`);
        return it;
      };

      for (const r of dto.removeItems ?? []) {
        const it = find(r.itemId);
        const sent = it.ticketItems.length > 0;
        // Taking back something the kitchen already has is a cancellation and needs that right.
        if (sent) requireInBranch(actor, order.branchId, ['orders.cancel'], 'Order');
        await tx.orderItem.update({
          where: { id: it.id },
          data: { status: 'CANCELLED', kitchenStatus: 'CANCELLED', cancelledAt: new Date(), cancelledById: actor.userId, cancelReason: r.reason.trim() },
        });
        if (sent) await tx.kitchenTicketItem.updateMany({ where: { orderItemId: it.id }, data: { status: 'CANCELLED', updatedById: actor.userId } });
      }
      for (const u of dto.updateItems ?? []) {
        const it = find(u.itemId);
        if (it.ticketItems.length) {
          throw Errors.conflict('ITEM_SENT_TO_KITCHEN', `"${it.productName}" is already with the kitchen; add a new line or cancel it instead`);
        }
        await tx.orderItem.update({ where: { id: it.id }, data: { quantity: new Dec(u.quantity) } });
      }
      const added = dto.addItems?.length ? await buildItems(tx, actor, settings, dto.addItems) : [];
      if (added.length) await insertItems(tx, id, actor.userId, added);

      await tx.order.update({
        where: { id },
        data: {
          customerName: dto.customerName === undefined ? undefined : dto.customerName.trim() || null,
          customerPhone: dto.customerPhone,
          deliveryAddress: dto.deliveryAddress === undefined ? undefined : dto.deliveryAddress.trim() || null,
          notes: dto.notes === undefined ? undefined : dto.notes.trim() || null,
          version: { increment: 1 },
        },
      });
      const { result } = await recomputeOrder(tx, id);
      await this.audit.record(
        {
          organizationId: actor.organizationId,
          branchId: order.branchId,
          actorUserId: actor.userId,
          action: 'order.updated',
          entityType: 'order',
          entityId: id,
          before: { grandTotal: order.grandTotal, version: order.version },
          after: { addItems: dto.addItems, updateItems: dto.updateItems, removeItems: dto.removeItems, grandTotal: result.grandTotal },
          metadata: priceOverrides(added),
          meta,
        },
        tx,
      );
    });
    return this.get(actor, id);
  }

  // ───────────── Discounts ─────────────

  async applyDiscount(actor: AuthPrincipal, id: string, dto: ApplyDiscountDto, meta: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockForChange(tx, actor, id, ['billing.discount.apply'], dto.version);
      if (isFinal(order.status)) throw Errors.unprocessable('ORDER_NOT_EDITABLE', `A ${order.status.toLowerCase()} order cannot be discounted`);
      await this.assertNotInvoiced(tx, id);
      const value = new Dec(dto.value);
      if (value.lte(0)) throw Errors.badRequest('INVALID_DISCOUNT', 'Discount value must be greater than 0');
      if (dto.type === 'PERCENTAGE' && value.gt(100)) throw Errors.badRequest('INVALID_DISCOUNT', 'A percentage discount cannot exceed 100');
      if (dto.scope === 'ITEM') {
        if (!dto.orderItemId) throw Errors.badRequest('ORDER_ITEM_REQUIRED', 'orderItemId is required for an item discount');
        const it = await tx.orderItem.findFirst({ where: { id: dto.orderItemId, orderId: id, status: 'ACTIVE' } });
        if (!it) throw Errors.badRequest('INVALID_ORDER_ITEM', 'Item not found on this order');
      } else if (dto.orderItemId) {
        throw Errors.badRequest('INVALID_DISCOUNT', 'orderItemId is only allowed for item discounts');
      }

      const row = await tx.appliedDiscount.create({
        data: {
          orderId: id,
          orderItemId: dto.scope === 'ITEM' ? dto.orderItemId : null,
          type: dto.type,
          scope: dto.scope,
          value,
          amount: 0,
          reason: dto.reason.trim(),
          appliedById: actor.userId,
        },
      });
      const { result, settings } = await recomputeOrder(tx, id);

      // The cashier limit applies to the order's total discount, so it cannot be dodged by
      // splitting one large discount into several small ones.
      const pct = result.subtotal.isZero() ? new Dec(0) : result.discountTotal.mul(100).div(result.subtotal);
      const overLimit = pct.gt(settings.maxCashierDiscountPct);
      if (overLimit) {
        if (!actor.permissions.has('billing.discount.override', order.branchId)) {
          throw Errors.forbidden('DISCOUNT_LIMIT_EXCEEDED', `Discounts above ${settings.maxCashierDiscountPct.toString()}% of the bill need a manager`, {
            missing: ['billing.discount.override'],
            discountPercent: pct.toDecimalPlaces(2).toString(),
            limitPercent: settings.maxCashierDiscountPct.toString(),
          });
        }
        await tx.appliedDiscount.update({ where: { id: row.id }, data: { approvedById: actor.userId } });
      }
      await tx.order.update({ where: { id }, data: { version: { increment: 1 } } });
      await this.audit.record(
        {
          organizationId: actor.organizationId,
          branchId: order.branchId,
          actorUserId: actor.userId,
          action: overLimit ? 'order.discount_applied_override' : 'order.discount_applied',
          entityType: 'order',
          entityId: id,
          before: { discountTotal: order.discountTotal, grandTotal: order.grandTotal },
          after: { discountId: row.id, scope: dto.scope, type: dto.type, value: dto.value, reason: dto.reason, discountTotal: result.discountTotal, grandTotal: result.grandTotal },
          meta,
        },
        tx,
      );
    });
    return this.get(actor, id);
  }

  async removeDiscount(actor: AuthPrincipal, id: string, discountId: string, version: number, meta: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockForChange(tx, actor, id, ['billing.discount.apply'], version);
      if (isFinal(order.status)) throw Errors.unprocessable('ORDER_NOT_EDITABLE', 'This order can no longer be changed');
      await this.assertNotInvoiced(tx, id);
      const d = await tx.appliedDiscount.findFirst({ where: { id: discountId, orderId: id } });
      if (!d) throw Errors.notFound('Discount');
      await tx.appliedDiscount.delete({ where: { id: discountId } });
      await tx.order.update({ where: { id }, data: { version: { increment: 1 } } });
      const { result } = await recomputeOrder(tx, id);
      await this.audit.record(
        { organizationId: actor.organizationId, branchId: order.branchId, actorUserId: actor.userId, action: 'order.discount_removed', entityType: 'order', entityId: id, before: d, after: { grandTotal: result.grandTotal }, meta },
        tx,
      );
    });
    return this.get(actor, id);
  }

  // ───────────── Kitchen & status ─────────────

  /** NEW → CONFIRMED and sends every item to the kitchen. */
  async confirm(actor: AuthPrincipal, id: string, dto: VersionDto, meta: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockForChange(tx, actor, id, ['kot.submit'], dto.version);
      if (order.status !== 'NEW') throw Errors.unprocessable('INVALID_TRANSITION', `Only new orders can be confirmed (this one is ${order.status})`);
      const active = await tx.orderItem.count({ where: { orderId: id, status: 'ACTIVE' } });
      if (!active) throw Errors.unprocessable('ORDER_EMPTY', 'Add at least one item before confirming');
      await this.setStatus(tx, actor, order, 'CONFIRMED', null);
      const tickets = await this.createKots(tx, actor, order);
      await this.log(tx, actor, order, 'order.confirmed', { status: 'NEW' }, { status: 'CONFIRMED', tickets }, meta);
    });
    return this.get(actor, id);
  }

  /** Sends items added after confirmation to the kitchen. */
  async sendToKitchen(actor: AuthPrincipal, id: string, dto: VersionDto, meta: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockForChange(tx, actor, id, ['kot.submit'], dto.version);
      if (order.status === 'NEW' || isFinal(order.status)) {
        throw Errors.unprocessable('INVALID_TRANSITION', order.status === 'NEW' ? 'Confirm the order first' : 'This order is closed');
      }
      const tickets = await this.createKots(tx, actor, order);
      if (!tickets.length) throw Errors.unprocessable('NOTHING_TO_SEND', 'Every item is already with the kitchen');
      await tx.order.update({ where: { id }, data: { version: { increment: 1 } } });
      await this.log(tx, actor, order, 'order.kot_sent', undefined, { tickets }, meta);
    });
    return this.get(actor, id);
  }

  async changeStatus(actor: AuthPrincipal, id: string, dto: ChangeStatusDto, meta: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockForChange(tx, actor, id, ['orders.update'], dto.version);
      if (dto.status === 'CANCELLED') throw Errors.badRequest('USE_CANCEL', 'Use POST /orders/:id/cancel with a reason');
      if (dto.status === 'CONFIRMED' && order.status === 'NEW') throw Errors.badRequest('USE_CONFIRM', 'Use POST /orders/:id/confirm to send it to the kitchen');
      if (!canTransition(order.orderType, order.status, dto.status)) {
        throw Errors.unprocessable('INVALID_TRANSITION', `A ${order.orderType} order cannot go from ${order.status} to ${dto.status}`, {
          allowed: nextStatuses(order.orderType, order.status),
        });
      }
      if (dto.status === 'COMPLETED') await this.assertSettled(tx, id);
      await this.setStatus(tx, actor, order, dto.status, null);
      // A pre-paid order (takeaway paid at the counter) completes as soon as it is handed over.
      const completed = dto.status !== 'COMPLETED' && (await this.completeIfSettled(tx, actor, id));
      await this.log(tx, actor, order, 'order.status_changed', { status: order.status }, { status: completed ? 'COMPLETED' : dto.status }, meta);
    });
    return this.get(actor, id);
  }

  async cancel(actor: AuthPrincipal, id: string, dto: ReasonDto, meta: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockForChange(tx, actor, id, ['orders.cancel'], dto.version);
      if (isFinal(order.status)) throw Errors.unprocessable('INVALID_TRANSITION', `The order is already ${order.status.toLowerCase()}`);
      const invoice = await tx.invoice.findFirst({ where: { orderId: id, status: { not: 'CANCELLED' } } });
      if (invoice) {
        throw Errors.conflict('ORDER_INVOICED', `Invoice ${invoice.invoiceNumber} is issued for this order; cancel the invoice (refunding any payment) first`);
      }
      const now = new Date();
      const reason = dto.reason.trim();
      await tx.orderItem.updateMany({
        where: { orderId: id, status: 'ACTIVE' },
        data: { status: 'CANCELLED', kitchenStatus: 'CANCELLED', cancelledAt: now, cancelledById: actor.userId, cancelReason: `Order cancelled: ${reason}` },
      });
      await tx.kitchenTicketItem.updateMany({ where: { ticket: { orderId: id }, status: { not: 'SERVED' } }, data: { status: 'CANCELLED', updatedById: actor.userId } });
      await tx.kitchenTicket.updateMany({ where: { orderId: id, status: { notIn: ['SERVED', 'CANCELLED'] } }, data: { status: 'CANCELLED' } });
      await tx.order.update({
        where: { id },
        data: { status: 'CANCELLED', cancelledAt: now, cancelledById: actor.userId, cancelReason: reason, version: { increment: 1 } },
      });
      await tx.orderStatusHistory.create({ data: { orderId: id, fromStatus: order.status, toStatus: 'CANCELLED', reason, changedById: actor.userId } });
      await this.log(tx, actor, order, 'order.cancelled', { status: order.status, grandTotal: order.grandTotal }, { status: 'CANCELLED', reason }, meta);
    });
    return this.get(actor, id);
  }

  /**
   * Undoes a completion or cancellation. A cancelled order gets back the items its cancellation
   * took (not items cancelled individually before); a completed order returns to its last stage.
   */
  async reopen(actor: AuthPrincipal, id: string, dto: ReasonDto, meta: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockForChange(tx, actor, id, ['orders.reopen'], dto.version);
      if (!isFinal(order.status)) throw Errors.unprocessable('INVALID_TRANSITION', 'Only completed or cancelled orders can be reopened');
      if (order.tableSessionId) {
        const s = await tx.tableSession.findUnique({ where: { id: order.tableSessionId } });
        if (s?.closedAt) throw Errors.conflict('TABLE_CLOSED', 'The table session of this order is closed; start a new order instead');
      }
      const reason = dto.reason.trim();
      let to: OrderStatus;
      if (order.status === 'CANCELLED') {
        to = order.confirmedAt ? 'CONFIRMED' : 'NEW';
        await tx.orderItem.updateMany({
          where: { orderId: id, status: 'CANCELLED', cancelledAt: order.cancelledAt, cancelReason: { startsWith: 'Order cancelled: ' } },
          data: { status: 'ACTIVE', kitchenStatus: 'PENDING', cancelledAt: null, cancelledById: null, cancelReason: null },
        });
      } else {
        const last = await tx.orderStatusHistory.findFirst({ where: { orderId: id, toStatus: 'COMPLETED' }, orderBy: { createdAt: 'desc' } });
        to = last?.fromStatus ?? 'SERVED';
        await tx.order.update({ where: { id }, data: { completedAt: null } });
      }
      await this.setStatus(tx, actor, order, to, reason);
      // Cleared only after leaving CANCELLED: the DB requires a cancelled order to keep its reason.
      if (order.status === 'CANCELLED') await tx.order.update({ where: { id }, data: { cancelledAt: null, cancelledById: null, cancelReason: null } });
      await recomputeOrder(tx, id);
      await this.log(tx, actor, order, 'order.reopened', { status: order.status }, { status: to, reason }, meta);
    });
    return this.get(actor, id);
  }

  // ───────────── Used by billing ─────────────

  /** After a payment: completes a served/picked-up/delivered order once its bill is settled. */
  async completeIfSettled(tx: Tx, actor: AuthPrincipal, orderId: string) {
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    if (!COMPLETABLE.includes(order.status) || order.paymentStatus === 'UNPAID' || order.paymentStatus === 'PARTIALLY_PAID') return false;
    await this.setStatus(tx, actor, order, 'COMPLETED', null);
    return true;
  }

  // ───────────── Internals ─────────────

  /** Row-locks the order, checks branch permission and the optimistic version. */
  private async lockForChange(tx: Tx, actor: AuthPrincipal, id: string, permissions: string[], version: number) {
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${id}::uuid AND organization_id = ${actor.organizationId}::uuid FOR UPDATE`;
    const order = await tx.order.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!order) throw Errors.notFound('Order');
    requireInBranch(actor, order.branchId, ['orders.read', ...permissions], 'Order');
    if (order.version !== version) {
      throw Errors.conflict('CONCURRENT_UPDATE', 'This order was changed by someone else; reload and try again', { currentVersion: order.version });
    }
    return order;
  }

  private async assertNotInvoiced(tx: Tx, orderId: string) {
    const inv = await tx.invoice.findFirst({ where: { orderId, status: { not: 'CANCELLED' } }, select: { invoiceNumber: true } });
    if (inv) throw Errors.conflict('ORDER_INVOICED', `Invoice ${inv.invoiceNumber} is already issued; cancel it to change the order`);
  }

  private async assertSettled(tx: Tx, orderId: string) {
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    const inv = await tx.invoice.findFirst({ where: { orderId, status: 'FINALIZED' } });
    if (!inv) throw Errors.unprocessable('ORDER_NOT_BILLED', 'Generate the bill before completing the order');
    if (order.paymentStatus === 'UNPAID' || order.paymentStatus === 'PARTIALLY_PAID') {
      throw Errors.unprocessable('ORDER_NOT_PAID', 'The bill is not fully paid');
    }
  }

  private async setStatus(tx: Tx, actor: AuthPrincipal, order: { id: string; status: OrderStatus }, to: OrderStatus, reason: string | null) {
    const now = new Date();
    await tx.order.update({
      where: { id: order.id },
      data: {
        status: to,
        confirmedAt: to === 'CONFIRMED' ? now : undefined,
        completedAt: to === 'COMPLETED' ? now : undefined,
        version: { increment: 1 },
      },
    });
    await tx.orderStatusHistory.create({ data: { orderId: order.id, fromStatus: order.status, toStatus: to, reason, changedById: actor.userId } });
  }

  /** One kitchen ticket per station for active items not yet sent. */
  private async createKots(tx: Tx, actor: AuthPrincipal, order: { id: string; organizationId: string; branchId: string }) {
    const pending = await tx.orderItem.findMany({
      where: { orderId: order.id, status: 'ACTIVE', ticketItems: { none: {} } },
      orderBy: { createdAt: 'asc' },
    });
    if (!pending.length) return [];
    const stations = await tx.kitchenStation.findMany({ where: { branchId: order.branchId, isActive: true } });
    const groups = new Map<string, typeof pending>();
    for (const it of pending) {
      const k = it.stationCode ?? '';
      groups.set(k, [...(groups.get(k) ?? []), it]);
    }
    const day = istDay();
    const created: { ticketNumber: string; station: string | null; items: number }[] = [];
    for (const [code, items] of groups) {
      const { value } = await nextNumber(tx, { organizationId: order.organizationId, branchId: order.branchId, type: 'KOT', prefix: 'KOT', period: day });
      const ticketNumber = `K${day}-${String(value).padStart(4, '0')}`;
      await tx.kitchenTicket.create({
        data: {
          organizationId: order.organizationId,
          branchId: order.branchId,
          orderId: order.id,
          stationId: stations.find((s) => s.code === code)?.id ?? null,
          ticketNumber,
          createdById: actor.userId,
          items: { create: items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })) },
        },
      });
      created.push({ ticketNumber, station: code || null, items: items.length });
    }
    return created;
  }

  private log(tx: Tx, actor: AuthPrincipal, order: { id: string; branchId: string }, action: string, before: unknown, after: unknown, meta: RequestMeta) {
    return this.audit.record(
      { organizationId: actor.organizationId, branchId: order.branchId, actorUserId: actor.userId, action, entityType: 'order', entityId: order.id, before, after, meta },
      tx,
    );
  }
}

function priceOverrides(items: { productName: string; unitPrice: Prisma.Decimal; priceOverride: { reason: string; menuPrice: Prisma.Decimal } | null }[]) {
  const o = items.filter((i) => i.priceOverride).map((i) => ({ product: i.productName, price: i.unitPrice, menuPrice: i.priceOverride!.menuPrice, reason: i.priceOverride!.reason }));
  return o.length ? { priceOverrides: o } : undefined;
}
