import { Injectable } from '@nestjs/common';
import { KitchenStatus, Prisma } from '@prisma/client';
import { hasInBranch, requireInBranch } from '../../common/auth/branch-access';
import { WithMeta } from '../../common/dto/pagination';
import { Errors } from '../../common/errors/app-error';
import type { RequestMeta } from '../../common/http/request-meta';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthPrincipal } from '../auth/principal';
import { OrdersService } from '../orders/orders.service';
import { KitchenStatusDto, ListTicketsQuery } from './dto/kitchen.dto';
import { KitchenTarget, canAdvance, refreshTickets } from './kitchen-state';

type Tx = Prisma.TransactionClient;

const TICKET_VIEW = {
  station: { select: { id: true, code: true, name: true } },
  order: {
    select: {
      id: true,
      orderNumber: true,
      orderType: true,
      status: true,
      customerName: true,
      guestCount: true,
      notes: true,
      tableSession: { select: { table: { select: { id: true, label: true } } } },
    },
  },
  items: {
    orderBy: { orderItem: { createdAt: 'asc' } },
    include: {
      orderItem: { select: { id: true, productName: true, variantName: true, specialInstructions: true, modifiers: { select: { name: true, quantity: true } } } },
    },
  },
} satisfies Prisma.KitchenTicketInclude;

type TicketRow = Prisma.KitchenTicketGetPayload<{ include: typeof TICKET_VIEW }>;

const LIVE: KitchenStatus[] = ['PENDING', 'PREPARING', 'READY'];

/**
 * Kitchen display: tickets per station and item-by-item progress. Each item moves on its own
 * (PENDING → PREPARING → READY → SERVED); the ticket and the order follow their slowest item.
 */
@Injectable()
export class KitchenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly orders: OrdersService,
  ) {}

  async list(actor: AuthPrincipal, q: ListTicketsQuery) {
    if (q.stationId) {
      const station = await this.prisma.kitchenStation.findFirst({ where: { id: q.stationId, branchId: q.branchId, organizationId: actor.organizationId } });
      if (!station) throw Errors.badRequest('INVALID_STATION', 'The kitchen station does not belong to this branch');
    }
    const statuses = q.status?.length ? q.status : q.updatedSince ? undefined : LIVE;
    const rows = await this.prisma.kitchenTicket.findMany({
      where: {
        organizationId: actor.organizationId,
        branchId: q.branchId,
        stationId: q.stationId,
        status: statuses ? { in: statuses } : undefined,
        updatedAt: q.updatedSince ? { gte: new Date(q.updatedSince) } : undefined,
      },
      include: TICKET_VIEW,
      orderBy: [{ createdAt: 'asc' }, { ticketNumber: 'asc' }],
      take: q.limit,
    });
    const now = new Date();
    return new WithMeta(rows.map((r) => present(r, now)), { serverTime: now.toISOString(), count: rows.length });
  }

  async get(actor: AuthPrincipal, id: string) {
    const t = await this.prisma.kitchenTicket.findFirst({ where: { id, organizationId: actor.organizationId }, include: TICKET_VIEW });
    if (!t) throw Errors.notFound('Kitchen ticket');
    requireInBranch(actor, t.branchId, ['kot.read'], 'Kitchen ticket');
    return present(t, new Date());
  }

  /** Marks one item preparing, ready or served. */
  async setItemStatus(actor: AuthPrincipal, itemId: string, dto: KitchenStatusDto, meta: RequestMeta) {
    const ticketId = await this.prisma.$transaction(async (tx) => {
      const item = await tx.kitchenTicketItem.findFirst({
        where: { id: itemId, ticket: { organizationId: actor.organizationId } },
        include: { ticket: { select: { id: true, orderId: true, branchId: true } } },
      });
      if (!item) throw Errors.notFound('Kitchen item');
      const order = await this.lockOrder(tx, actor, item.ticket.orderId, item.ticket.branchId, dto.status);
      const fresh = await tx.kitchenTicketItem.findUniqueOrThrow({ where: { id: itemId } });
      if (fresh.status === dto.status) return item.ticket.id; // a repeated tap changes nothing
      if (fresh.status === 'CANCELLED') throw Errors.conflict('ITEM_CANCELLED', 'This item was cancelled');
      if (!canAdvance(fresh.status, dto.status)) {
        throw Errors.unprocessable('INVALID_TRANSITION', `An item that is ${fresh.status.toLowerCase()} cannot go back to ${dto.status.toLowerCase()}`);
      }
      await this.advance(tx, actor, [fresh], dto.status);
      await refreshTickets(tx, [item.ticket.id]);
      const orderSteps = await this.orders.syncKitchenProgress(tx, actor, order.id);
      await this.log(tx, actor, item.ticket.branchId, 'kot.item.status_changed', 'kot_item', itemId, { status: fresh.status }, { status: dto.status, orderSteps }, meta);
      return item.ticket.id;
    });
    return this.get(actor, ticketId);
  }

  /** Moves every unfinished item of a ticket to the status at once ("bump"). */
  async setTicketStatus(actor: AuthPrincipal, ticketId: string, dto: KitchenStatusDto, meta: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      const ticket = await tx.kitchenTicket.findFirst({ where: { id: ticketId, organizationId: actor.organizationId } });
      if (!ticket) throw Errors.notFound('Kitchen ticket');
      await this.lockOrder(tx, actor, ticket.orderId, ticket.branchId, dto.status);
      const items = await tx.kitchenTicketItem.findMany({ where: { ticketId } });
      const moving = items.filter((i) => canAdvance(i.status, dto.status));
      if (!moving.length) {
        if (items.every((i) => i.status === 'CANCELLED')) throw Errors.conflict('TICKET_CANCELLED', 'Every item on this ticket was cancelled');
        if (items.some((i) => i.status === dto.status)) return; // already there
        throw Errors.unprocessable('INVALID_TRANSITION', `This ticket's items are past ${dto.status.toLowerCase()}`);
      }
      await this.advance(tx, actor, moving, dto.status);
      await refreshTickets(tx, [ticketId]);
      const orderSteps = await this.orders.syncKitchenProgress(tx, actor, ticket.orderId);
      await this.log(tx, actor, ticket.branchId, 'kot.status_changed', 'kot', ticketId, { status: ticket.status }, { status: dto.status, items: moving.length, orderSteps }, meta);
    });
    return this.get(actor, ticketId);
  }

  // ───────────── Internals ─────────────

  /**
   * Checks the right for the step and locks the order, so kitchen taps, waiter edits and payments
   * on one order are applied one at a time (always order first, then its tickets).
   */
  private async lockOrder(tx: Tx, actor: AuthPrincipal, orderId: string, branchId: string, to: KitchenTarget) {
    const access = actor.permissions.accessibleBranches();
    if (access !== 'ALL' && !access.includes(branchId)) throw Errors.notFound('Kitchen item');
    // Serving is done by floor staff as well as the kitchen.
    const canServe = to === 'SERVED' && hasInBranch(actor, branchId, 'orders.update');
    requireInBranch(actor, branchId, canServe ? ['kot.read'] : ['kot.read', 'kot.update_status'], 'Kitchen item');
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    if (order.status === 'CANCELLED') throw Errors.conflict('ORDER_CANCELLED', 'This order was cancelled');
    return order;
  }

  /** Sets the status and fills the timestamps of every step reached (skipped steps get the same time). */
  private async advance(tx: Tx, actor: AuthPrincipal, items: { id: string; orderItemId: string; startedAt: Date | null; readyAt: Date | null }[], to: KitchenTarget) {
    const now = new Date();
    for (const i of items) {
      await tx.kitchenTicketItem.update({
        where: { id: i.id },
        data: {
          status: to,
          updatedById: actor.userId,
          startedAt: i.startedAt ?? now,
          readyAt: to === 'READY' || to === 'SERVED' ? (i.readyAt ?? now) : undefined,
          servedAt: to === 'SERVED' ? now : undefined,
        },
      });
      await tx.orderItem.update({ where: { id: i.orderItemId }, data: { kitchenStatus: to } });
    }
  }

  private log(tx: Tx, actor: AuthPrincipal, branchId: string, action: string, entityType: string, entityId: string, before: unknown, after: unknown, meta: RequestMeta) {
    return this.audit.record({ organizationId: actor.organizationId, branchId, actorUserId: actor.userId, action, entityType, entityId, before, after, meta }, tx);
  }
}

function present(t: TicketRow, now: Date) {
  const end = t.status === 'READY' || t.status === 'SERVED' || t.status === 'CANCELLED' ? (t.completedAt ?? t.updatedAt) : now;
  return {
    id: t.id,
    ticketNumber: t.ticketNumber,
    status: t.status,
    station: t.station,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    completedAt: t.completedAt,
    /** Seconds since the ticket reached the kitchen; stops counting once it is ready. */
    elapsedSeconds: Math.max(0, Math.floor((end.getTime() - t.createdAt.getTime()) / 1000)),
    order: {
      id: t.order.id,
      orderNumber: t.order.orderNumber,
      orderType: t.order.orderType,
      status: t.order.status,
      table: t.order.tableSession?.table ?? null,
      customerName: t.order.customerName,
      guestCount: t.order.guestCount,
      notes: t.order.notes,
    },
    items: t.items.map((i) => ({
      id: i.id,
      orderItemId: i.orderItemId,
      productName: i.orderItem.productName,
      variantName: i.orderItem.variantName,
      quantity: i.quantity,
      instructions: i.orderItem.specialInstructions,
      modifiers: i.orderItem.modifiers.map((m) => (m.quantity > 1 ? `${m.name} ×${m.quantity}` : m.name)),
      status: i.status,
      startedAt: i.startedAt,
      readyAt: i.readyAt,
      servedAt: i.servedAt,
    })),
  };
}
