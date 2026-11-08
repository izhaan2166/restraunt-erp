import { OrderStatus, OrderType } from '@prisma/client';

const S = OrderStatus;

/**
 * Allowed forward transitions per order type. CANCELLED (with a reason) is reachable from every
 * non-final state through the cancel endpoint; reopening is a separate, permissioned action.
 */
const FLOW: Record<OrderType, Partial<Record<OrderStatus, OrderStatus[]>>> = {
  DINE_IN: {
    NEW: [S.CONFIRMED],
    CONFIRMED: [S.PREPARING, S.READY, S.SERVED],
    PREPARING: [S.READY],
    READY: [S.SERVED],
    SERVED: [S.COMPLETED],
  },
  TAKEAWAY: {
    NEW: [S.CONFIRMED],
    CONFIRMED: [S.PREPARING, S.READY],
    PREPARING: [S.READY],
    READY: [S.PICKED_UP],
    PICKED_UP: [S.COMPLETED],
  },
  DELIVERY: {
    NEW: [S.CONFIRMED],
    CONFIRMED: [S.PREPARING, S.READY],
    PREPARING: [S.READY],
    READY: [S.OUT_FOR_DELIVERY],
    OUT_FOR_DELIVERY: [S.DELIVERED],
    DELIVERED: [S.COMPLETED],
  },
};

export const FINAL_STATUSES: OrderStatus[] = [S.COMPLETED, S.CANCELLED];
/** Items can be added or changed until the food has left the kitchen pass. */
export const EDITABLE_STATUSES: OrderStatus[] = [S.NEW, S.CONFIRMED, S.PREPARING, S.READY, S.SERVED];

export function nextStatuses(type: OrderType, from: OrderStatus): OrderStatus[] {
  return FLOW[type][from] ?? [];
}

export function canTransition(type: OrderType, from: OrderStatus, to: OrderStatus): boolean {
  return nextStatuses(type, from).includes(to);
}

export const isFinal = (s: OrderStatus) => FINAL_STATUSES.includes(s);
