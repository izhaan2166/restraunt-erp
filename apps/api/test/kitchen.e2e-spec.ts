import { API, TestContext, createTestApp } from './helpers/app';
import { OrgFixture, bearer, createOrg, tokenFor } from './helpers/fixtures';
import { MenuFixture, addTable, key, seedMenu } from './helpers/menu';

interface TicketItem {
  id: string;
  orderItemId: string;
  productName: string;
  variantName: string | null;
  quantity: string;
  instructions: string | null;
  modifiers: string[];
  status: string;
  startedAt: string | null;
  readyAt: string | null;
  servedAt: string | null;
}
interface Ticket {
  id: string;
  ticketNumber: string;
  status: string;
  station: { id: string; code: string; name: string } | null;
  elapsedSeconds: number;
  createdAt: string;
  completedAt: string | null;
  order: { id: string; orderNumber: string; orderType: string; status: string; table: { label: string } | null; notes: string | null };
  items: TicketItem[];
}
interface Order {
  id: string;
  version: number;
  status: string;
  items: { id: string; productName: string; kitchenStatus: string; status: string }[];
}

describe('Kitchen display (e2e)', () => {
  let ctx: TestContext;
  let fx: OrgFixture;
  let other: OrgFixture;
  let menu: MenuFixture;
  const tok: Record<string, string> = {};

  const http = () => ctx.http();
  const getOrder = async (id: string) => (await http().get(`${API}/orders/${id}`).set(bearer(tok.waiterA)).expect(200)).body.data as Order;
  const board = async (q: Record<string, string> = {}, token = tok.kitchenA) =>
    (await http().get(`${API}/kot`).query({ branchId: fx.branchA, ...q }).set(bearer(token)).expect(200)).body.data as Ticket[];
  const ticket = async (id: string, token = tok.kitchenA) => (await http().get(`${API}/kot/${id}`).set(bearer(token)).expect(200)).body.data as Ticket;
  const mark = (itemId: string, status: string, token = tok.kitchenA) => http().patch(`${API}/kot/items/${itemId}/status`).set(bearer(token)).send({ status });
  const bump = (ticketId: string, status: string, token = tok.kitchenA) => http().post(`${API}/kot/${ticketId}/status`).set(bearer(token)).send({ status });

  /** A confirmed dine-in order with a paneer (MAIN) and a lassi (BEV): two tickets. */
  async function confirmedOrder(items: object[] = defaultItems()) {
    const tableId = await addTable(ctx.prisma, fx, fx.branchA, `K${Math.floor(Math.random() * 1e6)}`);
    await http().post(`${API}/branches/${fx.branchA}/tables/${tableId}/open`).set(bearer(tok.waiterA)).send({ guestCount: 2 }).expect(201);
    let o = (
      await http()
        .post(`${API}/orders`)
        .set(bearer(tok.waiterA))
        .set('Idempotency-Key', key())
        .send({ branchId: fx.branchA, orderType: 'DINE_IN', tableId, notes: 'Birthday', items })
        .expect(201)
    ).body.data as Order;
    o = (await http().post(`${API}/orders/${o.id}/confirm`).set(bearer(tok.waiterA)).send({ version: o.version }).expect(201)).body.data;
    const tickets = (await board()).filter((t) => t.order.id === o.id);
    const main = tickets.find((t) => t.station?.code === 'MAIN')!;
    const bev = tickets.find((t) => t.station?.code === 'BEV')!;
    return { order: o, tableId, main, bev };
  }
  const defaultItems = () => [
    { productId: menu.paneer.id, variantId: menu.paneer.full, quantity: '1', instructions: 'Less spicy', modifiers: [{ modifierId: menu.cheese }] },
    { productId: menu.lassi, quantity: '2' },
  ];

  beforeAll(async () => {
    ctx = await createTestApp();
    fx = await createOrg(ctx.prisma, 'Kitchen');
    other = await createOrg(ctx.prisma, 'KitchenOther');
    menu = await seedMenu(ctx.prisma, fx);
    for (const h of ['owner', 'managerA', 'managerB', 'cashierA', 'waiterA', 'kitchenA', 'accountant']) tok[h] = await tokenFor(ctx, fx, h);
    tok.otherOwner = await tokenFor(ctx, other, 'owner');
  });
  afterAll(() => ctx.close());

  it('confirming an order puts one ticket per station on the kitchen screen with everything the cook needs', async () => {
    const { order, main, bev } = await confirmedOrder();
    expect(main).toEqual(
      expect.objectContaining({
        status: 'PENDING',
        ticketNumber: expect.stringMatching(/^K\d{8}-\d{4}$/),
        station: expect.objectContaining({ code: 'MAIN', name: 'Main' }),
        order: expect.objectContaining({ id: order.id, orderType: 'DINE_IN', status: 'CONFIRMED', notes: 'Birthday', table: expect.objectContaining({ label: expect.stringMatching(/^K/) }) }),
      }),
    );
    expect(main.order.orderNumber).toMatch(/^\d{8}-\d{4}$/);
    expect(main.items).toEqual([
      expect.objectContaining({ productName: 'Paneer Tikka', variantName: 'Full', quantity: '1', instructions: 'Less spicy', modifiers: ['Extra cheese'], status: 'PENDING' }),
    ]);
    expect(bev.items).toEqual([expect.objectContaining({ productName: 'Sweet Lassi', quantity: '2', status: 'PENDING' })]);
    expect(main.elapsedSeconds).toBeGreaterThanOrEqual(0);

    // Each station sees only its own tickets.
    const bevBoard = await board({ stationId: bev.station!.id });
    expect(bevBoard.every((t) => t.station?.code === 'BEV')).toBe(true);
    expect(bevBoard.map((t) => t.id)).toContain(bev.id);
    expect(bevBoard.map((t) => t.id)).not.toContain(main.id);
    // Waiters can watch the board too.
    expect((await board({}, tok.waiterA)).map((t) => t.id)).toContain(main.id);
  });

  it('one ready item does not make the order ready; the order follows its slowest item', async () => {
    const { order, main, bev } = await confirmedOrder();
    const lassi = bev.items[0];
    const paneer = main.items[0];

    let t = (await mark(lassi.id, 'READY').expect(200)).body.data as Ticket;
    expect(t.status).toBe('READY');
    expect(t.items[0]).toEqual(expect.objectContaining({ status: 'READY', startedAt: expect.any(String), readyAt: expect.any(String) }));
    expect((await getOrder(order.id)).status).toBe('PREPARING');

    t = (await mark(paneer.id, 'PREPARING').expect(200)).body.data as Ticket;
    expect(t.status).toBe('PREPARING');
    expect((await getOrder(order.id)).status).toBe('PREPARING');

    await mark(paneer.id, 'READY').expect(200);
    let o = await getOrder(order.id);
    expect(o.status).toBe('READY');
    expect(o.items.map((i) => i.kitchenStatus).sort()).toEqual(['READY', 'READY']);

    // The waiter serves; the order is served once both items are.
    await mark(lassi.id, 'SERVED', tok.waiterA).expect(200);
    expect((await getOrder(order.id)).status).toBe('READY');
    await mark(paneer.id, 'SERVED', tok.waiterA).expect(200);
    o = await getOrder(order.id);
    expect(o.status).toBe('SERVED');

    const history = await ctx.prisma.orderStatusHistory.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'asc' } });
    expect(history.map((h) => h.toStatus).slice(-4)).toEqual(['CONFIRMED', 'PREPARING', 'READY', 'SERVED']);
    const served = await ticket(main.id);
    expect(served).toEqual(expect.objectContaining({ status: 'SERVED', completedAt: expect.any(String) }));

    // Paying now completes the order.
    const inv = (await http().post(`${API}/billing/checkout`).set(bearer(tok.cashierA)).set('Idempotency-Key', key()).send({ orderId: order.id, payments: [] }).expect(200)).body.data;
    await http().post(`${API}/invoices/${inv.id}/payments`).set(bearer(tok.cashierA)).set('Idempotency-Key', key()).send({ method: 'UPI', amount: inv.outstanding }).expect(201);
    expect((await getOrder(order.id)).status).toBe('COMPLETED');
  });

  it('a dine-in bill paid before the food is served completes the order when the last item is served', async () => {
    const { order, main, bev } = await confirmedOrder([{ productId: menu.lassi, quantity: '1' }]);
    expect(main).toBeUndefined();
    const inv = (await http().post(`${API}/billing/checkout`).set(bearer(tok.cashierA)).set('Idempotency-Key', key()).send({ orderId: order.id, payments: [] }).expect(200)).body.data;
    await http().post(`${API}/invoices/${inv.id}/payments`).set(bearer(tok.cashierA)).set('Idempotency-Key', key()).send({ method: 'CASH', amount: inv.outstanding }).expect(201);
    expect((await getOrder(order.id)).status).toBe('CONFIRMED');
    await bump(bev.id, 'SERVED', tok.waiterA).expect(200);
    expect((await getOrder(order.id)).status).toBe('COMPLETED');
  });

  it('only kitchen staff (kot.update_status) mark preparing or ready; floor staff may mark served', async () => {
    const { main } = await confirmedOrder();
    const res = await mark(main.items[0].id, 'PREPARING', tok.waiterA).expect(403);
    expect(res.body.error.code).toBe('MISSING_PERMISSION');
    await bump(main.id, 'READY', tok.cashierA).expect(403);
    // Accountants cannot see the kitchen at all.
    await http().get(`${API}/kot`).query({ branchId: fx.branchA }).set(bearer(tok.accountant)).expect(403);
    await mark(main.items[0].id, 'SERVED', tok.waiterA).expect(200);
    expect((await ticket(main.id)).items[0]).toEqual(expect.objectContaining({ status: 'SERVED', startedAt: expect.any(String), readyAt: expect.any(String), servedAt: expect.any(String) }));
  });

  it('items only move forward; a repeated tap changes nothing', async () => {
    const { main } = await confirmedOrder();
    const item = main.items[0];
    await mark(item.id, 'READY').expect(200);
    const before = await ctx.prisma.kitchenTicketItem.findUniqueOrThrow({ where: { id: item.id } });
    await mark(item.id, 'READY').expect(200);
    const after = await ctx.prisma.kitchenTicketItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.readyAt).toEqual(before.readyAt);
    const back = await mark(item.id, 'PREPARING').expect(422);
    expect(back.body.error.code).toBe('INVALID_TRANSITION');
    await mark(item.id, 'PENDING').expect(400);
    await bump(main.id, 'PREPARING').expect(422);
  });

  it('"bumping" a ticket moves every unfinished item at once', async () => {
    const { order, main, bev } = await confirmedOrder([
      { productId: menu.lassi, quantity: '1' },
      { productId: menu.lassi, quantity: '1', instructions: 'No sugar' },
      { productId: menu.paneer.id, variantId: menu.paneer.half, quantity: '1' },
    ]);
    expect(bev.items).toHaveLength(2);
    await mark(bev.items[0].id, 'READY').expect(200);
    const t = (await bump(bev.id, 'READY').expect(200)).body.data as Ticket;
    expect(t.items.map((i) => i.status)).toEqual(['READY', 'READY']);
    expect((await getOrder(order.id)).status).toBe('PREPARING');
    await bump(main.id, 'READY').expect(200);
    expect((await getOrder(order.id)).status).toBe('READY');
  });

  it('items added after the order is ready go out as a new ticket; the order stays ready', async () => {
    const { order, main, bev } = await confirmedOrder();
    await bump(main.id, 'READY').expect(200);
    await bump(bev.id, 'READY').expect(200);
    let o = await getOrder(order.id);
    expect(o.status).toBe('READY');
    o = (await http().patch(`${API}/orders/${order.id}`).set(bearer(tok.waiterA)).send({ version: o.version, addItems: [{ productId: menu.lassi, quantity: '1' }] }).expect(200)).body.data;
    o = (await http().post(`${API}/orders/${order.id}/kot`).set(bearer(tok.waiterA)).send({ version: o.version }).expect(201)).body.data;
    const live = (await board()).filter((t) => t.order.id === order.id);
    expect(live.map((t) => [t.station?.code, t.status]).sort()).toEqual([
      ['BEV', 'PENDING'],
      ['BEV', 'READY'],
      ['MAIN', 'READY'],
    ]);
    expect((await getOrder(order.id)).status).toBe('READY');
  });

  it('taking back a sent item cancels it on the screen and can leave the rest of the order ready', async () => {
    const { order, main, bev } = await confirmedOrder();
    await bump(bev.id, 'READY').expect(200);
    let o = await getOrder(order.id);
    expect(o.status).toBe('PREPARING');
    const paneer = o.items.find((i) => i.productName === 'Paneer Tikka')!;
    o = (
      await http()
        .patch(`${API}/orders/${order.id}`)
        .set(bearer(tok.managerA))
        .send({ version: o.version, removeItems: [{ itemId: paneer.id, reason: 'Guest changed mind' }] })
        .expect(200)
    ).body.data;
    expect(o.status).toBe('READY');
    const t = await ticket(main.id);
    expect(t).toEqual(expect.objectContaining({ status: 'CANCELLED' }));
    expect(t.items[0].status).toBe('CANCELLED');
    expect((await board()).map((x) => x.id)).not.toContain(main.id);
    const res = await mark(t.items[0].id, 'READY').expect(409);
    expect(res.body.error.code).toBe('ITEM_CANCELLED');
  });

  it('cancelling an order clears its tickets; reopening it lets the items be sent again', async () => {
    const { order, main, bev } = await confirmedOrder();
    await mark(bev.items[0].id, 'PREPARING').expect(200);
    let o = await getOrder(order.id);
    o = (await http().post(`${API}/orders/${order.id}/cancel`).set(bearer(tok.managerA)).send({ version: o.version, reason: 'Guest left' }).expect(201)).body.data;
    expect((await ticket(main.id)).status).toBe('CANCELLED');
    expect((await ticket(bev.id)).status).toBe('CANCELLED');
    const res = await mark(main.items[0].id, 'READY').expect(409);
    expect(res.body.error.code).toBe('ORDER_CANCELLED');

    o = (await http().post(`${API}/orders/${order.id}/reopen`).set(bearer(tok.managerA)).send({ version: o.version, reason: 'Guest came back' }).expect(201)).body.data;
    expect(o.status).toBe('CONFIRMED');
    o = (await http().post(`${API}/orders/${order.id}/kot`).set(bearer(tok.waiterA)).send({ version: o.version }).expect(201)).body.data;
    const live = (await board()).filter((t) => t.order.id === order.id);
    expect(live).toHaveLength(2);
    expect(live.every((t) => t.status === 'PENDING' && ![main.id, bev.id].includes(t.id))).toBe(true);
  });

  it('simultaneous taps on one order are applied one at a time and the order becomes ready exactly once', async () => {
    const { order } = await confirmedOrder([
      { productId: menu.lassi, quantity: '1' },
      { productId: menu.lassi, quantity: '2' },
      { productId: menu.paneer.id, variantId: menu.paneer.half, quantity: '1' },
      { productId: menu.paneer.id, variantId: menu.paneer.full, quantity: '1' },
      { productId: menu.thali, quantity: '1', modifiers: [{ modifierId: menu.roti }] },
    ]);
    const items = (await board()).filter((t) => t.order.id === order.id).flatMap((t) => t.items);
    expect(items).toHaveLength(5);
    const results = await Promise.all(items.map((i) => mark(i.id, 'READY')));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect((await getOrder(order.id)).status).toBe('READY');
    const history = await ctx.prisma.orderStatusHistory.findMany({ where: { orderId: order.id, toStatus: 'READY' } });
    expect(history).toHaveLength(1);
  });

  it('screens catch up with ?updatedSince=, which includes tickets that left the board', async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const { main } = await confirmedOrder();
    await bump(main.id, 'SERVED', tok.waiterA).expect(200);
    const changed = await board({ updatedSince: since });
    expect(changed.find((t) => t.id === main.id)?.status).toBe('SERVED');
    expect((await board()).map((t) => t.id)).not.toContain(main.id);
    expect((await board({ status: 'SERVED' })).map((t) => t.id)).toContain(main.id);
  });

  it('kitchen tickets stay inside their branch and organization', async () => {
    const { main } = await confirmedOrder();
    await http().get(`${API}/kot/${main.id}`).set(bearer(tok.managerB)).expect(404);
    await http().get(`${API}/kot/${main.id}`).set(bearer(tok.otherOwner)).expect(404);
    await mark(main.items[0].id, 'READY', tok.otherOwner).expect(404);
    await http().get(`${API}/kot`).query({ branchId: fx.branchB }).set(bearer(tok.kitchenA)).expect(403);
    await http().get(`${API}/kot`).query({ branchId: other.branchA }).set(bearer(tok.kitchenA)).expect(404);
    const bStations = await ctx.prisma.kitchenStation.findFirstOrThrow({ where: { branchId: fx.branchB } });
    const res = await http().get(`${API}/kot`).query({ branchId: fx.branchA, stationId: bStations.id }).set(bearer(tok.kitchenA)).expect(400);
    expect(res.body.error.code).toBe('INVALID_STATION');
  });

  it('records who changed each item, in the item and the audit log', async () => {
    const { main } = await confirmedOrder();
    await mark(main.items[0].id, 'READY').expect(200);
    const item = await ctx.prisma.kitchenTicketItem.findUniqueOrThrow({ where: { id: main.items[0].id } });
    expect(item.updatedById).toBe(fx.users.kitchenA.id);
    const log = await ctx.prisma.auditLog.findFirst({ where: { entityId: item.id, action: 'kot.item.status_changed' } });
    expect(log).toEqual(expect.objectContaining({ actorUserId: fx.users.kitchenA.id, before: { status: 'PENDING' } }));
  });
});
