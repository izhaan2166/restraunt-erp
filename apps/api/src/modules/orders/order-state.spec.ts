import { OrderStatus as S } from '@prisma/client';
import { canTransition, nextStatuses } from './order-state';

describe('order state machine', () => {
  it('dine-in: NEW → CONFIRMED → PREPARING → READY → SERVED → COMPLETED', () => {
    const path = [S.NEW, S.CONFIRMED, S.PREPARING, S.READY, S.SERVED, S.COMPLETED];
    for (let i = 0; i < path.length - 1; i++) expect(canTransition('DINE_IN', path[i], path[i + 1])).toBe(true);
  });

  it('takeaway goes through PICKED_UP and delivery through OUT_FOR_DELIVERY → DELIVERED', () => {
    expect(canTransition('TAKEAWAY', S.READY, S.PICKED_UP)).toBe(true);
    expect(canTransition('TAKEAWAY', S.READY, S.SERVED)).toBe(false);
    expect(canTransition('DELIVERY', S.READY, S.OUT_FOR_DELIVERY)).toBe(true);
    expect(canTransition('DELIVERY', S.OUT_FOR_DELIVERY, S.DELIVERED)).toBe(true);
    expect(canTransition('DELIVERY', S.DELIVERED, S.COMPLETED)).toBe(true);
    expect(canTransition('DELIVERY', S.READY, S.PICKED_UP)).toBe(false);
  });

  it('no skipping, no going back, nothing after a final state', () => {
    expect(canTransition('DINE_IN', S.NEW, S.SERVED)).toBe(false);
    expect(canTransition('DINE_IN', S.SERVED, S.READY)).toBe(false);
    expect(canTransition('DINE_IN', S.NEW, S.COMPLETED)).toBe(false);
    expect(nextStatuses('DINE_IN', S.COMPLETED)).toEqual([]);
    expect(nextStatuses('TAKEAWAY', S.CANCELLED)).toEqual([]);
  });
});
