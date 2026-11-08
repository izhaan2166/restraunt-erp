import { canAdvance, orderProgress, ticketStatus } from './kitchen-state';

describe('kitchen state', () => {
  it('moves items forward only', () => {
    expect(canAdvance('PENDING', 'PREPARING')).toBe(true);
    expect(canAdvance('PENDING', 'READY')).toBe(true);
    expect(canAdvance('READY', 'PREPARING')).toBe(false);
    expect(canAdvance('READY', 'READY')).toBe(false);
    expect(canAdvance('CANCELLED', 'SERVED')).toBe(false);
  });

  it('derives the ticket status from its slowest live item', () => {
    expect(ticketStatus(['PENDING', 'PENDING'])).toBe('PENDING');
    expect(ticketStatus(['READY', 'PENDING'])).toBe('PREPARING');
    expect(ticketStatus(['READY', 'PREPARING'])).toBe('PREPARING');
    expect(ticketStatus(['READY', 'SERVED'])).toBe('READY');
    expect(ticketStatus(['READY', 'CANCELLED'])).toBe('READY');
    expect(ticketStatus(['SERVED', 'CANCELLED'])).toBe('SERVED');
    expect(ticketStatus(['CANCELLED', 'CANCELLED'])).toBe('CANCELLED');
  });

  it('one ready item does not make the order ready', () => {
    const items = [
      { sent: true, status: 'READY' as const },
      { sent: true, status: 'PENDING' as const },
    ];
    expect(orderProgress('DINE_IN', 'CONFIRMED', items)).toEqual(['PREPARING']);
    expect(orderProgress('DINE_IN', 'PREPARING', items)).toEqual([]);
  });

  it('an order is ready when every item is ready, and served when every item is served', () => {
    const ready = [
      { sent: true, status: 'READY' as const },
      { sent: true, status: 'SERVED' as const },
    ];
    expect(orderProgress('DINE_IN', 'CONFIRMED', ready)).toEqual(['READY']);
    expect(orderProgress('DINE_IN', 'PREPARING', ready)).toEqual(['READY']);
    const served = ready.map((i) => ({ ...i, status: 'SERVED' as const }));
    expect(orderProgress('DINE_IN', 'CONFIRMED', served)).toEqual(['SERVED']);
    expect(orderProgress('DINE_IN', 'PREPARING', served)).toEqual(['READY', 'SERVED']);
    expect(orderProgress('TAKEAWAY', 'PREPARING', served)).toEqual(['READY']);
  });

  it('items not yet sent to the kitchen hold the order back', () => {
    expect(
      orderProgress('DINE_IN', 'PREPARING', [
        { sent: true, status: 'READY' },
        { sent: false, status: 'PENDING' },
      ]),
    ).toEqual([]);
  });

  it('never moves an order back or out of a status the kitchen does not drive', () => {
    const pending = [{ sent: true, status: 'PENDING' as const }];
    expect(orderProgress('DINE_IN', 'READY', pending)).toEqual([]);
    expect(orderProgress('DINE_IN', 'NEW', [{ sent: true, status: 'READY' }])).toEqual([]);
    expect(orderProgress('TAKEAWAY', 'PICKED_UP', [{ sent: true, status: 'SERVED' }])).toEqual([]);
    expect(orderProgress('DINE_IN', 'CONFIRMED', [])).toEqual([]);
  });
});
