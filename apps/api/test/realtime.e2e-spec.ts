import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import { RealtimeService } from '../src/modules/realtime/realtime.service';
import { API, TestContext, createTestApp } from './helpers/app';
import { OrgFixture, bearer, createOrg, login, tokenFor } from './helpers/fixtures';
import { MenuFixture, addTable, key, seedMenu } from './helpers/menu';

interface Ev {
  id: number;
  type: string;
  topic: string;
  branchId: string;
  entityType: string;
  entityId: string;
  entityVersion: number | null;
  data: Record<string, unknown>;
}
type Ack = { ok: boolean; topics?: string[]; events?: Ev[]; lastSeq?: number; resyncRequired?: boolean; error?: { code: string } };

/** A connected client that records every event it receives. */
interface Client {
  socket: Socket;
  events: Ev[];
  subscribe: (body: object) => Promise<Ack>;
  close: () => void;
}

describe('Realtime events (e2e)', () => {
  let ctx: TestContext;
  let relay: RealtimeService;
  let url: string;
  let fx: OrgFixture;
  let other: OrgFixture;
  let menu: MenuFixture;
  const tok: Record<string, string> = {};
  const open: Client[] = [];

  async function connect(token: string | undefined): Promise<Client> {
    const socket = io(url, { path: '/realtime', transports: ['websocket'], auth: token ? { token } : {}, reconnection: false, forceNew: true });
    const events: Ev[] = [];
    socket.on('event', (e: Ev) => events.push(e));
    await new Promise<void>((resolve, reject) => {
      socket.once('ready', () => resolve());
      socket.once('connect_error', (err: Error & { data?: { code: string } }) => reject(err));
    });
    const c: Client = {
      socket,
      events,
      subscribe: (body) => socket.timeout(5000).emitWithAck('subscribe', body) as Promise<Ack>,
      close: () => socket.disconnect(),
    };
    open.push(c);
    return c;
  }

  async function connectError(token: string | undefined) {
    const socket = io(url, { path: '/realtime', transports: ['websocket'], auth: token ? { token } : {}, reconnection: false, forceNew: true });
    try {
      return await new Promise<{ code?: string }>((resolve) => {
        socket.once('connect_error', (err: Error & { data?: { code: string } }) => resolve(err.data ?? {}));
        socket.once('ready', () => resolve({ code: 'CONNECTED' }));
      });
    } finally {
      socket.disconnect();
    }
  }

  /** Publishes committed events now and waits until the predicate holds. */
  async function until(pred: () => boolean, what: string) {
    const deadline = Date.now() + 5000;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await relay.flush();
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  const settle = async () => {
    await relay.flush();
    await new Promise((r) => setTimeout(r, 150));
  };
  const headSeq = async () => Number((await ctx.prisma.realtimeEvent.aggregate({ _max: { seq: true } }))._max.seq ?? 0n);

  const post = (path: string, body: object, token: string) => ctx.http().post(`${API}${path}`).set(bearer(token)).set('Idempotency-Key', key()).send(body);

  async function openTable(branchId = fx.branchA, token = tok.waiterA) {
    const tableId = await addTable(ctx.prisma, fx, branchId, `R${Math.floor(Math.random() * 1e6)}`);
    await ctx.http().post(`${API}/branches/${branchId}/tables/${tableId}/open`).set(bearer(token)).send({ guestCount: 2 }).expect(201);
    return tableId;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    await ctx.app.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${(ctx.app.getHttpServer().address() as AddressInfo).port}`;
    relay = ctx.app.get(RealtimeService);
    fx = await createOrg(ctx.prisma, 'Realtime');
    other = await createOrg(ctx.prisma, 'RealtimeOther');
    menu = await seedMenu(ctx.prisma, fx);
    for (const h of ['owner', 'managerA', 'managerB', 'cashierA', 'waiterA', 'kitchenA', 'accountant']) tok[h] = await tokenFor(ctx, fx, h);
    tok.otherOwner = await tokenFor(ctx, other, 'owner');
  });
  afterEach(() => {
    while (open.length) open.pop()!.close();
  });
  afterAll(() => ctx.close());

  describe('connecting and subscribing', () => {
    it('refuses connections without a valid access token or with a signed-out session', async () => {
      expect(await connectError(undefined)).toEqual(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
      expect(await connectError('not-a-token')).toEqual(expect.objectContaining({ code: 'INVALID_ACCESS_TOKEN' }));
      const s = await login(ctx, fx.users.cashierA.email);
      await ctx.http().post(`${API}/auth/logout`).send({ refreshToken: s.refreshToken }).expect(204);
      expect(await connectError(s.accessToken)).toEqual(expect.objectContaining({ code: 'SESSION_INVALID' }));
    });

    it('joins only the topics the caller may read in that branch', async () => {
      const kitchen = await connect(tok.kitchenA);
      expect(await kitchen.subscribe({ branchId: fx.branchA })).toEqual(expect.objectContaining({ ok: true, topics: ['kitchen'] }));
      const waiter = await connect(tok.waiterA);
      expect((await waiter.subscribe({ branchId: fx.branchA })).topics).toEqual(['orders', 'kitchen', 'tables']);
      const cashier = await connect(tok.cashierA);
      expect((await cashier.subscribe({ branchId: fx.branchA, topics: ['payments'] })).topics).toEqual(['payments']);
      expect(await kitchen.subscribe({ branchId: fx.branchA, topics: ['payments'] })).toEqual(
        expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'MISSING_PERMISSION' }) }),
      );
    });

    it('cannot subscribe to another branch or organization', async () => {
      const waiter = await connect(tok.waiterA);
      expect((await waiter.subscribe({ branchId: fx.branchB })).error?.code).toBe('NOT_FOUND');
      const owner = await connect(tok.owner);
      expect((await owner.subscribe({ branchId: other.branchA })).error?.code).toBe('NOT_FOUND');
      expect((await owner.subscribe({ branchId: 'nope' })).error?.code).toBe('VALIDATION_FAILED');
      expect((await owner.subscribe({ branchId: fx.branchA, topics: ['secrets'] })).error?.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('live delivery', () => {
    it('POS, kitchen and cashier screens each get the events of their topics, in order', async () => {
      const waiter = await connect(tok.waiterA);
      const kitchen = await connect(tok.kitchenA);
      const cashier = await connect(tok.cashierA);
      await waiter.subscribe({ branchId: fx.branchA });
      await kitchen.subscribe({ branchId: fx.branchA });
      await cashier.subscribe({ branchId: fx.branchA });

      const tableId = await openTable();
      let o = (await post('/orders', { branchId: fx.branchA, orderType: 'DINE_IN', tableId, items: [{ productId: menu.lassi, quantity: '1' }] }, tok.waiterA).expect(201)).body.data;
      o = (await ctx.http().post(`${API}/orders/${o.id}/confirm`).set(bearer(tok.waiterA)).send({ version: o.version }).expect(201)).body.data;
      await until(() => kitchen.events.some((e) => e.type === 'kot.created' && e.data.orderId === o.id), 'kot.created');

      const tables = waiter.events.filter((e) => e.type === 'table.status.updated' && e.entityId === tableId);
      expect(tables.at(-1)?.data).toEqual(expect.objectContaining({ status: 'OCCUPIED' }));
      expect(waiter.events.filter((e) => e.entityId === o.id).map((e) => e.type)).toEqual(['order.created', 'order.updated']);
      expect(waiter.events.find((e) => e.type === 'order.updated' && e.entityId === o.id)?.data).toEqual(expect.objectContaining({ status: 'CONFIRMED', orderNumber: o.orderNumber }));
      // The kitchen screen sees tickets, not orders or tables.
      expect(kitchen.events.every((e) => e.topic === 'kitchen')).toBe(true);

      const ticket = kitchen.events.find((e) => e.type === 'kot.created' && e.data.orderId === o.id)!;
      const t = (await ctx.http().get(`${API}/kot/${ticket.entityId}`).set(bearer(tok.kitchenA)).expect(200)).body.data;
      await ctx.http().patch(`${API}/kot/items/${t.items[0].id}/status`).set(bearer(tok.kitchenA)).send({ status: 'READY' }).expect(200);
      await until(() => waiter.events.some((e) => e.entityId === o.id && e.data.status === 'READY'), 'order READY');
      expect(kitchen.events.find((e) => e.type === 'kot.item.updated' && e.entityId === t.items[0].id)?.data).toEqual(
        expect.objectContaining({ status: 'READY', ticketId: t.id, orderId: o.id }),
      );

      const inv = (await post('/billing/checkout', { orderId: o.id, payments: [] }, tok.cashierA).expect(200)).body.data;
      await post(`/invoices/${inv.id}/payments`, { method: 'UPI', amount: inv.outstanding }, tok.cashierA).expect(201);
      await until(() => cashier.events.some((e) => e.type === 'payment.completed' && e.data.orderId === o.id), 'payment.completed');
      expect(cashier.events.find((e) => e.type === 'payment.completed')?.data).toEqual(expect.objectContaining({ method: 'UPI', amount: inv.outstanding }));
      // Waiters cannot see payments.
      expect(waiter.events.some((e) => e.topic === 'payments')).toBe(false);

      for (const c of [waiter, kitchen, cashier]) {
        const ids = c.events.map((e) => e.id);
        expect(ids).toEqual([...ids].sort((a, b) => a - b));
        expect(new Set(ids).size).toBe(ids.length);
      }
    });

    it('several changes to one record in one request become one event with the final state', async () => {
      const after = await headSeq();
      const tableId = await openTable();
      const o = (await post('/orders', { branchId: fx.branchA, orderType: 'DINE_IN', tableId, items: [{ productId: menu.lassi, quantity: '3' }] }, tok.waiterA).expect(201)).body.data;
      await relay.flush();
      const rows = await ctx.prisma.realtimeEvent.findMany({ where: { entityId: o.id, seq: { gt: BigInt(after) } } });
      expect(rows.map((r) => r.type)).toEqual(['order.created']);
      expect(rows[0].payload).toEqual(expect.objectContaining({ grandTotal: o.grandTotal, version: o.version }));
    });

    it('a request that fails sends nothing: events exist only for committed changes', async () => {
      const tableId = await openTable();
      let o = (
        await post('/orders', { branchId: fx.branchA, orderType: 'DINE_IN', tableId, items: [{ productId: menu.lassi, quantity: '1' }, { productId: menu.paneer.id, variantId: menu.paneer.half, quantity: '1' }] }, tok.waiterA).expect(201)
      ).body.data;
      o = (await ctx.http().post(`${API}/orders/${o.id}/confirm`).set(bearer(tok.waiterA)).send({ version: o.version }).expect(201)).body.data;
      await relay.flush();
      const after = await headSeq();
      const [a, b] = o.items;
      // Cancels a sent item (written), then refuses to change the other one → the whole request rolls back.
      await ctx.http()
        .patch(`${API}/orders/${o.id}`)
        .set(bearer(tok.managerA))
        .send({ version: o.version, removeItems: [{ itemId: a.id, reason: 'Mistake' }], updateItems: [{ itemId: b.id, quantity: '2' }] })
        .expect(409);
      await relay.flush();
      const leaked = await ctx.prisma.realtimeEvent.count({ where: { branchId: fx.branchA, seq: { gt: BigInt(after) } } });
      expect(leaked).toBe(0);
      expect(await ctx.prisma.realtimeEvent.count({ where: { seq: null, branchId: fx.branchA } })).toBe(0);
    });

    it('never delivers another branch’s events', async () => {
      const waiter = await connect(tok.waiterA);
      await waiter.subscribe({ branchId: fx.branchA });
      const tableId = await openTable(fx.branchB, tok.managerB);
      const o = (await post('/orders', { branchId: fx.branchB, orderType: 'DINE_IN', tableId, items: [{ productId: menu.lassi, quantity: '1' }] }, tok.managerB).expect(201)).body.data;
      const owner = await connect(tok.owner);
      await owner.subscribe({ branchId: fx.branchB, topics: ['orders'] });
      await post('/orders', { branchId: fx.branchB, orderType: 'TAKEAWAY', items: [{ productId: menu.lassi, quantity: '1' }] }, tok.managerB).expect(201);
      await until(() => owner.events.some((e) => e.type === 'order.created'), 'branch B order for the owner');
      await settle();
      expect(waiter.events.some((e) => e.branchId === fx.branchB || e.entityId === o.id || e.entityId === tableId)).toBe(false);
    });
  });

  describe('catching up after a reconnect', () => {
    it('replays missed events on subscribe and through the REST endpoint', async () => {
      const first = await connect(tok.waiterA);
      await first.subscribe({ branchId: fx.branchA });
      await settle();
      const lastSeen = await headSeq();
      first.close();

      // Changes made while the screen was offline.
      const tableId = await openTable();
      const o = (await post('/orders', { branchId: fx.branchA, orderType: 'DINE_IN', tableId, items: [{ productId: menu.lassi, quantity: '1' }] }, tok.waiterA).expect(201)).body.data;
      await relay.flush();

      const again = await connect(tok.waiterA);
      const ack = await again.subscribe({ branchId: fx.branchA, since: lastSeen });
      expect(ack.ok).toBe(true);
      expect(ack.events!.map((e) => [e.type, e.entityId])).toEqual(
        expect.arrayContaining([
          ['table.status.updated', tableId],
          ['order.created', o.id],
        ]),
      );
      expect(ack.events!.every((e) => e.id > lastSeen && e.branchId === fx.branchA)).toBe(true);
      expect(ack.lastSeq).toBeGreaterThanOrEqual(Math.max(...ack.events!.map((e) => e.id)));

      const res = await ctx.http().get(`${API}/realtime/events`).query({ branchId: fx.branchA, after: lastSeen, topics: 'orders' }).set(bearer(tok.waiterA)).expect(200);
      expect(res.body.data.map((e: Ev) => e.type)).toEqual(['order.created']);
      expect(res.body.meta).toEqual(expect.objectContaining({ hasMore: false, topics: ['orders'], lastSeq: expect.any(Number) }));

      // Paging: one event per page, the cursor moves on.
      const page = await ctx.http().get(`${API}/realtime/events`).query({ branchId: fx.branchA, after: lastSeen, limit: 1 }).set(bearer(tok.waiterA)).expect(200);
      expect(page.body.data).toHaveLength(1);
      expect(page.body.meta.hasMore).toBe(true);
      expect(page.body.meta.lastSeq).toBe(page.body.data[0].id);
    });

    it('asks the client to reload when the gap can no longer be replayed', async () => {
      const head = await headSeq();
      const ahead = await ctx.http().get(`${API}/realtime/events`).query({ branchId: fx.branchA, after: head + 1000 }).set(bearer(tok.waiterA)).expect(410);
      expect(ahead.body.error.code).toBe('RESYNC_REQUIRED');

      // Simulate retention: the oldest events are gone.
      const oldest = await ctx.prisma.realtimeEvent.findFirstOrThrow({ where: { seq: { not: null } }, orderBy: { seq: 'asc' } });
      await ctx.prisma.realtimeEvent.delete({ where: { id: oldest.id } });
      const gone = await ctx.http().get(`${API}/realtime/events`).query({ branchId: fx.branchA, after: Number(oldest.seq) - 1 }).set(bearer(tok.waiterA)).expect(410);
      expect(gone.body.error.code).toBe('RESYNC_REQUIRED');
      const c = await connect(tok.waiterA);
      expect(await c.subscribe({ branchId: fx.branchA, since: Number(oldest.seq) - 1 })).toEqual(expect.objectContaining({ ok: true, resyncRequired: true }));
    });

    it('checks topic rights and branch access on the REST endpoint too', async () => {
      await ctx.http().get(`${API}/realtime/events`).query({ branchId: fx.branchB, after: 0 }).set(bearer(tok.waiterA)).expect(404);
      await ctx.http().get(`${API}/realtime/events`).query({ branchId: other.branchA, after: 0 }).set(bearer(tok.owner)).expect(404);
      await ctx.http().get(`${API}/realtime/events`).query({ branchId: fx.branchA, after: 0, topics: 'payments' }).set(bearer(tok.kitchenA)).expect(403);
      await ctx.http().get(`${API}/realtime/events`).query({ branchId: fx.branchA }).set(bearer(tok.kitchenA)).expect(400);
      await ctx.http().get(`${API}/realtime/events`).query({ branchId: fx.branchA, after: 0 }).expect(401);
    });
  });

  describe('several API instances', () => {
    it('number events once, without gaps, and every instance delivers them', async () => {
      const second = await createTestApp();
      try {
        await second.app.listen(0, '127.0.0.1');
        const secondRelay = second.app.get(RealtimeService);
        const port2 = (second.app.getHttpServer().address() as AddressInfo).port;
        const a = await connect(tok.waiterA);
        await a.subscribe({ branchId: fx.branchA, topics: ['orders'] });
        const s2 = io(`http://127.0.0.1:${port2}`, { path: '/realtime', transports: ['websocket'], auth: { token: tok.waiterA }, reconnection: false, forceNew: true });
        const b: Ev[] = [];
        s2.on('event', (e: Ev) => b.push(e));
        await new Promise<void>((r) => s2.once('ready', () => r()));
        await s2.timeout(5000).emitWithAck('subscribe', { branchId: fx.branchA, topics: ['orders'] });

        const after = await headSeq();
        const created = await Promise.all(
          Array.from({ length: 12 }, () => post('/orders', { branchId: fx.branchA, orderType: 'TAKEAWAY', items: [{ productId: menu.lassi, quantity: '1' }] }, tok.waiterA).expect(201)),
        );
        await Promise.all([relay.flush(), secondRelay.flush(), relay.flush(), secondRelay.flush()]);
        const ids = new Set(created.map((r) => r.body.data.id as string));
        const deadline = Date.now() + 5000;
        const got = (list: Ev[]) => list.filter((e) => ids.has(e.entityId)).length;
        while ((got(a.events) < 12 || got(b) < 12) && Date.now() < deadline) {
          await Promise.all([relay.flush(), secondRelay.flush()]);
          await new Promise((r) => setTimeout(r, 30));
        }
        expect(got(a.events)).toBe(12);
        expect(got(b)).toBe(12);
        expect(a.events.filter((e) => ids.has(e.entityId)).map((e) => e.id)).toEqual(b.filter((e) => ids.has(e.entityId)).map((e) => e.id));

        const rows = await ctx.prisma.realtimeEvent.findMany({ where: { seq: { gt: BigInt(after) } }, orderBy: { seq: 'asc' }, select: { seq: true } });
        const seqs = rows.map((r) => Number(r.seq));
        expect(seqs).toEqual(seqs.map((_, i) => after + 1 + i));
        s2.disconnect();
      } finally {
        await second.close();
      }
    });
  });
});
