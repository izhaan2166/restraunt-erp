import { KitchenStatus, OrderStatus, OrderType, Prisma } from '@prisma/client';
import { nextStatuses } from '../orders/order-state';

type Tx = Prisma.TransactionClient;

/** Kitchen progress of one item: PENDING → PREPARING → READY → SERVED (steps may be skipped). */
const RANK: Record<KitchenStatus, number> = { PENDING: 0, PREPARING: 1, READY: 2, SERVED: 3, CANCELLED: -1 };

export const KITCHEN_TARGETS = ['PREPARING', 'READY', 'SERVED'] as const;
export type KitchenTarget = (typeof KITCHEN_TARGETS)[number];

/** Items only move forward; cancelled items stay cancelled. */
export function canAdvance(from: KitchenStatus, to: KitchenTarget): boolean {
  return from !== 'CANCELLED' && RANK[to] > RANK[from];
}

/**
 * A ticket's status follows its slowest live item: it is READY only when every item is ready,
 * PREPARING as soon as any item is started, and CANCELLED when every item was cancelled.
 */
export function ticketStatus(items: KitchenStatus[]): KitchenStatus {
  const live = items.filter((s) => s !== 'CANCELLED');
  if (!live.length) return 'CANCELLED';
  const slowest = Math.min(...live.map((s) => RANK[s]));
  if (slowest >= RANK.SERVED) return 'SERVED';
  if (slowest >= RANK.READY) return 'READY';
  return live.some((s) => RANK[s] >= RANK.PREPARING) ? 'PREPARING' : 'PENDING';
}

const ORDER_RANK: Partial<Record<OrderStatus, number>> = { CONFIRMED: 0, PREPARING: 1, READY: 2, SERVED: 3 };

/**
 * The order statuses that kitchen progress moves an order through, in order. One ready item does
 * not make the order ready: it becomes READY only when every active item has been sent and is ready,
 * and (dine-in) SERVED when every item is served. Items not yet sent to the kitchen hold it back.
 * Orders are only moved forward, never back, and only along the allowed flow for their type.
 */
export function orderProgress(type: OrderType, current: OrderStatus, items: { sent: boolean; status: KitchenStatus }[]): OrderStatus[] {
  if (ORDER_RANK[current] === undefined || !items.length) return [];
  const ranks = items.map((i) => (i.sent ? RANK[i.status] : 0));
  const slowest = Math.min(...ranks);
  let desired: OrderStatus | null = null;
  if (slowest >= RANK.SERVED && type === 'DINE_IN') desired = 'SERVED';
  else if (slowest >= RANK.READY) desired = 'READY';
  else if (ranks.some((r) => r >= RANK.PREPARING)) desired = 'PREPARING';
  if (!desired || ORDER_RANK[desired]! <= ORDER_RANK[current]!) return [];

  const steps: OrderStatus[] = [];
  let at = current;
  while (at !== desired) {
    const options = nextStatuses(type, at).filter((s) => {
      const r = ORDER_RANK[s];
      return r !== undefined && r > ORDER_RANK[at]! && r <= ORDER_RANK[desired!]!;
    });
    if (!options.length) break;
    at = options.reduce((a, b) => (ORDER_RANK[b]! > ORDER_RANK[a]! ? b : a));
    steps.push(at);
  }
  return steps;
}

/** Re-derives each ticket's status from its items and stamps its last change. */
export async function refreshTickets(tx: Tx, ticketIds: string[]) {
  const now = new Date();
  for (const id of new Set(ticketIds)) {
    const t = await tx.kitchenTicket.findUniqueOrThrow({ where: { id }, include: { items: { select: { status: true } } } });
    const status = ticketStatus(t.items.map((i) => i.status));
    const done = status === 'READY' || status === 'SERVED';
    await tx.kitchenTicket.update({
      where: { id },
      data: { status, completedAt: done ? (t.completedAt ?? now) : null, updatedAt: now },
    });
  }
}
