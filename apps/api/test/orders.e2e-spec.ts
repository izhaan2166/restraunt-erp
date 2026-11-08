import { API, TestContext, createTestApp } from './helpers/app';
import { OrgFixture, bearer, createOrg, tokenFor } from './helpers/fixtures';
import { MenuFixture, addTable, key, seedMenu } from './helpers/menu';

describe('Orders (e2e)', () => {
  let ctx: TestContext;
  let fx: OrgFixture;
  let other: OrgFixture;
  let menu: MenuFixture;
  const tok: Record<string, string> = {};
  let t1: string;

  const post = (path: string, body: object, token = tok.waiterA, idem: string | null = key()) => {
    const r = ctx.http().post(`${API}${path}`).set(bearer(token));
    if (idem) r.set('Idempotency-Key', idem);
    return r.send(body);
  };
  const get = async (id: string, token = tok.waiterA) => (await ctx.http().get(`${API}/orders/${id}`).set(bearer(token)).expect(200)).body.data;
  const dineIn = (items: object[], tableId = t1) => ({ branchId: fx.branchA, orderType: 'DINE_IN', tableId, items });

  beforeAll(async () => {
    ctx = await createTestApp();
    fx = await createOrg(ctx.prisma, 'Orders');
    other = await createOrg(ctx.prisma, 'OrdersOther');
    menu = await seedMenu(ctx.prisma, fx);
    for (const h of ['owner', 'managerA', 'managerB', 'cashierA', 'waiterA', 'kitchenA']) tok[h] = await tokenFor(ctx, fx, h);
    tok.otherOwner = await tokenFor(ctx, other, 'owner');
    t1 = await addTable(ctx.prisma, fx, fx.branchA, 'T1');
    await ctx.http().post(`${API}/branches/${fx.branchA}/tables/${t1}/open`).set(bearer(tok.waiterA)).send({ guestCount: 2 }).expect(201);
  });
  afterAll(() => ctx.close());

  describe('creating orders', () => {
    it('requires an Idempotency-Key and replays a retry instead of creating a duplicate', async () => {
      const body = dineIn([{ productId: menu.lassi, quantity: '1' }]);
      const missing = await post('/orders', body, tok.waiterA, null).expect(400);
      expect(missing.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

      const k = key();
      const first = await post('/orders', body, tok.waiterA, k).expect(201);
      const retry = await post('/orders', body, tok.waiterA, k).expect(201);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body.data.id).toBe(first.body.data.id);
      expect(await ctx.prisma.order.count({ where: { organizationId: fx.orgId } })).toBe(1);

      const reused = await post('/orders', dineIn([{ productId: menu.lassi, quantity: '2' }]), tok.waiterA, k).expect(409);
      expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('simultaneous retries with one key create one order', async () => {
      const k = key();
      const body = dineIn([{ productId: menu.lassi, quantity: '3' }]);
      const before = await ctx.prisma.order.count({ where: { organizationId: fx.orgId } });
      const results = await Promise.all(Array.from({ length: 5 }, () => post('/orders', body, tok.waiterA, k)));
      expect(results.every((r) => r.status === 201 || (r.status === 409 && r.body.error.code === 'IDEMPOTENCY_IN_PROGRESS'))).toBe(true);
      const ids = new Set(results.filter((r) => r.status === 201).map((r) => r.body.data.id));
      expect(ids.size).toBe(1);
      expect(await ctx.prisma.order.count({ where: { organizationId: fx.orgId } })).toBe(before + 1);
    });

    it('prices the order on the server from the branch menu (client prices are rejected)', async () => {
      await post('/orders', dineIn([{ productId: menu.lassi, quantity: '1', unitPrice: '1.00' }])).expect(400);
      const res = await post(
        '/orders',
        dineIn([
          { productId: menu.paneer.id, variantId: menu.paneer.full, quantity: '2', modifiers: [{ modifierId: menu.cheese }] },
          { productId: menu.lassi, quantity: '1' },
        ]),
      ).expect(201);
      const o = res.body.data;
      // (320 + 40) × 2 + 90 = 810; 5% GST = 20.25 + 20.25; 850.50 rounds to 851.
      expect([o.subtotal, o.taxableAmount, o.cgstAmount, o.sgstAmount, o.taxTotal, o.roundOff, o.grandTotal]).toEqual([
        '810', '810', '20.25', '20.25', '40.5', '0.5', '851',
      ]);
      expect(o.orderNumber).toMatch(/^\d{8}-\d{4}$/);
      expect(o.status).toBe('NEW');
      const paneer = o.items.find((i: { productName: string }) => i.productName === 'Paneer Tikka');
      expect(paneer).toEqual(expect.objectContaining({ variantName: 'Full', unitPrice: '320', modifiersTotal: '80', lineSubtotal: '720', taxRate: '5' }));
      expect(o.tableSession.tableId).toBe(t1);
    });

    it('uses branch price overrides', async () => {
      await ctx.prisma.branchProductPrice.create({ data: { branchId: fx.branchA, productId: menu.lassi, price: '100' } });
      const res = await post('/orders', dineIn([{ productId: menu.lassi, quantity: '1' }])).expect(201);
      expect(res.body.data.items[0].unitPrice).toBe('100');
      await ctx.prisma.branchProductPrice.deleteMany({ where: { branchId: fx.branchA, productId: menu.lassi } });
    });

    it('enforces variants, add-on rules and availability', async () => {
      const code = async (items: object[], status: number) => (await post('/orders', dineIn(items)).expect(status)).body.error.code;
      expect(await code([{ productId: menu.paneer.id, quantity: '1' }], 400)).toBe('VARIANT_REQUIRED');
      expect(await code([{ productId: menu.lassi, variantId: menu.paneer.full, quantity: '1' }], 400)).toBe('INVALID_VARIANT');
      expect(await code([{ productId: menu.thali, quantity: '1' }], 400)).toBe('INVALID_MODIFIER_SELECTION');
      expect(await code([{ productId: menu.thali, quantity: '1', modifiers: [{ modifierId: menu.roti }, { modifierId: menu.naan }] }], 400)).toBe('INVALID_MODIFIER_SELECTION');
      expect(await code([{ productId: menu.lassi, quantity: '1', modifiers: [{ modifierId: menu.cheese }] }], 400)).toBe('INVALID_MODIFIER');
      expect(await code([{ productId: '00000000-0000-4000-8000-000000000000', quantity: '1' }], 400)).toBe('INVALID_PRODUCT');
      await ctx.prisma.product.update({ where: { id: menu.lassi }, data: { isAvailable: false } });
      expect(await code([{ productId: menu.lassi, quantity: '1' }], 409)).toBe('ITEM_UNAVAILABLE');
      await ctx.prisma.product.update({ where: { id: menu.lassi }, data: { isAvailable: true } });
      const ok = await post('/orders', dineIn([{ productId: menu.thali, quantity: '1', modifiers: [{ modifierId: menu.naan }] }])).expect(201);
      expect(ok.body.data.grandTotal).toBe('284'); // (250 + 20) × 1.05 = 283.50 → 284
    });

    it('dine-in needs an open table; delivery needs an address; takeaway takes no table', async () => {
      const closed = await addTable(ctx.prisma, fx, fx.branchA, 'T9');
      expect((await post('/orders', dineIn([{ productId: menu.lassi, quantity: '1' }], closed)).expect(409)).body.error.code).toBe('TABLE_NOT_OPEN');
      expect((await post('/orders', { branchId: fx.branchA, orderType: 'DINE_IN', items: [{ productId: menu.lassi, quantity: '1' }] }).expect(400)).body.error.code).toBe('TABLE_REQUIRED');
      expect((await post('/orders', { branchId: fx.branchA, orderType: 'DELIVERY', items: [{ productId: menu.lassi, quantity: '1' }] }).expect(400)).body.error.code).toBe('DELIVERY_ADDRESS_REQUIRED');
      expect((await post('/orders', { branchId: fx.branchA, orderType: 'TAKEAWAY', tableId: t1, items: [{ productId: menu.lassi, quantity: '1' }] }).expect(400)).body.error.code).toBe('TABLE_NOT_ALLOWED');
      const ta = await post('/orders', { branchId: fx.branchA, orderType: 'TAKEAWAY', customerName: 'Ravi', items: [{ productId: menu.lassi, quantity: '2' }] }).expect(201);
      expect(ta.body.data.grandTotal).toBe('189');
    });

    it('price overrides need billing.price.override and a reason', async () => {
      const item = { productId: menu.lassi, quantity: '1', unitPriceOverride: '50.00', overrideReason: 'Happy hour' };
      await post('/orders', dineIn([item]), tok.waiterA).expect(403);
      await post('/orders', dineIn([{ ...item, overrideReason: undefined }]), tok.owner).expect(400);
      const res = await post('/orders', dineIn([item]), tok.owner).expect(201);
      expect(res.body.data.items[0].unitPrice).toBe('50');
      const log = await ctx.prisma.auditLog.findFirst({ where: { entityId: res.body.data.id, action: 'order.created' } });
      expect(JSON.stringify(log!.metadata)).toContain('Happy hour');
    });
  });

  describe('editing, kitchen tickets and status', () => {
    let order: { id: string; version: number };
    const refresh = async () => (order = await get(order.id));

    beforeAll(async () => {
      const res = await post('/orders', dineIn([
        { productId: menu.paneer.id, variantId: menu.paneer.half, quantity: '1' },
        { productId: menu.lassi, quantity: '2' },
      ])).expect(201);
      order = res.body.data;
    });

    it('edits need the current version', async () => {
      await ctx.http().patch(`${API}/orders/${order.id}`).set(bearer(tok.waiterA)).send({ version: order.version, notes: 'Window seat' }).expect(200);
      const stale = await ctx.http().patch(`${API}/orders/${order.id}`).set(bearer(tok.waiterA)).send({ version: order.version, notes: 'x' }).expect(409);
      expect(stale.body.error.code).toBe('CONCURRENT_UPDATE');
      await refresh();
    });

    it('confirming sends one KOT per kitchen station', async () => {
      await ctx.http().post(`${API}/orders/${order.id}/status`).set(bearer(tok.waiterA)).send({ version: order.version, status: 'SERVED' }).expect(422);
      const res = await ctx.http().post(`${API}/orders/${order.id}/confirm`).set(bearer(tok.waiterA)).send({ version: order.version }).expect(201);
      expect(res.body.data.status).toBe('CONFIRMED');
      expect(res.body.data.kitchenTickets).toHaveLength(2);
      const tickets = await ctx.prisma.kitchenTicket.findMany({ where: { orderId: order.id }, include: { station: true, items: true } });
      expect(tickets.map((t) => t.station?.code).sort()).toEqual(['BEV', 'MAIN']);
      expect(tickets.every((t) => /^K\d{8}-\d{4}$/.test(t.ticketNumber))).toBe(true);
      await refresh();
    });

    it('items already with the kitchen cannot be resized; new items go on a new KOT', async () => {
      const lassi = (order as unknown as { items: { id: string; productName: string }[] }).items.find((i) => i.productName === 'Sweet Lassi')!;
      const res = await ctx.http().patch(`${API}/orders/${order.id}`).set(bearer(tok.waiterA)).send({ version: order.version, updateItems: [{ itemId: lassi.id, quantity: '3' }] }).expect(409);
      expect(res.body.error.code).toBe('ITEM_SENT_TO_KITCHEN');
      await ctx.http().patch(`${API}/orders/${order.id}`).set(bearer(tok.waiterA)).send({ version: order.version, addItems: [{ productId: menu.lassi, quantity: '1' }] }).expect(200);
      await refresh();
      const kot = await ctx.http().post(`${API}/orders/${order.id}/kot`).set(bearer(tok.waiterA)).send({ version: order.version }).expect(201);
      expect(kot.body.data.kitchenTickets).toHaveLength(3);
      await refresh();
      const again = await ctx.http().post(`${API}/orders/${order.id}/kot`).set(bearer(tok.waiterA)).send({ version: order.version }).expect(422);
      expect(again.body.error.code).toBe('NOTHING_TO_SEND');
    });

    it('taking back an item the kitchen has is a cancellation (waiters cannot)', async () => {
      const lassi = (order as unknown as { items: { id: string; productName: string; status: string }[] }).items.find((i) => i.productName === 'Sweet Lassi')!;
      const body = { version: order.version, removeItems: [{ itemId: lassi.id, reason: 'Guest changed mind' }] };
      await ctx.http().patch(`${API}/orders/${order.id}`).set(bearer(tok.waiterA)).send(body).expect(403);
      const res = await ctx.http().patch(`${API}/orders/${order.id}`).set(bearer(tok.managerA)).send(body).expect(200);
      const removed = res.body.data.items.find((i: { id: string }) => i.id === lassi.id);
      expect(removed).toEqual(expect.objectContaining({ status: 'CANCELLED', cancelReason: 'Guest changed mind' }));
      expect(res.body.data.grandTotal).toBe('284'); // 180 + 90 = 270 × 1.05 = 283.50 → 284
      const ti = await ctx.prisma.kitchenTicketItem.findFirst({ where: { orderItemId: lassi.id } });
      expect(ti!.status).toBe('CANCELLED');
      await refresh();
    });

    it('follows the dine-in flow and cannot complete before the bill is paid', async () => {
      for (const status of ['PREPARING', 'READY', 'SERVED']) {
        const res = await ctx.http().post(`${API}/orders/${order.id}/status`).set(bearer(tok.waiterA)).send({ version: order.version, status }).expect(201);
        expect(res.body.data.status).toBe(status);
        await refresh();
      }
      const done = await ctx.http().post(`${API}/orders/${order.id}/status`).set(bearer(tok.waiterA)).send({ version: order.version, status: 'COMPLETED' }).expect(422);
      expect(done.body.error.code).toBe('ORDER_NOT_BILLED');
      const history = await ctx.prisma.orderStatusHistory.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'asc' } });
      expect(history.map((h) => h.toStatus)).toEqual(['NEW', 'CONFIRMED', 'PREPARING', 'READY', 'SERVED']);
    });
  });

  describe('discounts', () => {
    let order: { id: string; version: number; grandTotal: string };
    beforeAll(async () => {
      order = (await post('/orders', dineIn([{ productId: menu.paneer.id, variantId: menu.paneer.full, quantity: '1' }]))).body.data;
    });

    it('a cashier discounts within the branch limit; beyond it needs a manager; waiters cannot', async () => {
      const disc = (token: string, value: string, version: number) =>
        ctx.http().post(`${API}/orders/${order.id}/discounts`).set(bearer(token)).send({ scope: 'ORDER', type: 'PERCENTAGE', value, reason: 'Regular guest', version });
      await disc(tok.waiterA, '5', order.version).expect(403);
      const ok = await disc(tok.cashierA, '5', order.version).expect(201);
      // 320 − 16 = 304 → 15.20 GST → 319.20 → 319
      expect([ok.body.data.discountTotal, ok.body.data.grandTotal]).toEqual(['16', '319']);
      const over = await disc(tok.cashierA, '10', ok.body.data.version).expect(403);
      expect(over.body.error.code).toBe('DISCOUNT_LIMIT_EXCEEDED');
      expect((await get(order.id)).appliedDiscounts).toHaveLength(1); // rolled back
      const mgr = await disc(tok.managerA, '10', ok.body.data.version).expect(201);
      // second 10% applies to the remaining 304 → 30.40; total discount 46.40
      expect(mgr.body.data.discountTotal).toBe('46.4');
      expect(mgr.body.data.appliedDiscounts[1].approvedById).toBe(fx.users.managerA.id);
      const rm = await ctx
        .http()
        .delete(`${API}/orders/${order.id}/discounts/${mgr.body.data.appliedDiscounts[1].id}`)
        .query({ version: mgr.body.data.version })
        .set(bearer(tok.managerA))
        .expect(200);
      expect(rm.body.data.discountTotal).toBe('16');
    });
  });

  describe('cancel and reopen', () => {
    it('cancel needs a reason and orders.cancel; reopen restores the items', async () => {
      const o = (await post('/orders', dineIn([{ productId: menu.lassi, quantity: '1' }]))).body.data;
      await ctx.http().post(`${API}/orders/${o.id}/cancel`).set(bearer(tok.managerA)).send({ version: o.version }).expect(400);
      await ctx.http().post(`${API}/orders/${o.id}/cancel`).set(bearer(tok.waiterA)).send({ version: o.version, reason: 'Walked out' }).expect(403);
      const c = await ctx.http().post(`${API}/orders/${o.id}/cancel`).set(bearer(tok.managerA)).send({ version: o.version, reason: 'Walked out' }).expect(201);
      expect(c.body.data).toEqual(expect.objectContaining({ status: 'CANCELLED', cancelReason: 'Walked out' }));
      expect(c.body.data.items[0].status).toBe('CANCELLED');
      await ctx.http().patch(`${API}/orders/${o.id}`).set(bearer(tok.managerA)).send({ version: c.body.data.version, notes: 'x' }).expect(422);
      const r = await ctx.http().post(`${API}/orders/${o.id}/reopen`).set(bearer(tok.managerA)).send({ version: c.body.data.version, reason: 'Came back' }).expect(201);
      expect(r.body.data.status).toBe('NEW');
      expect(r.body.data.items[0].status).toBe('ACTIVE');
      expect(r.body.data.grandTotal).toBe('95');
    });
  });

  describe('isolation', () => {
    it('orders are invisible outside their branch and organization', async () => {
      const o = (await post('/orders', dineIn([{ productId: menu.lassi, quantity: '1' }]))).body.data;
      await ctx.http().get(`${API}/orders/${o.id}`).set(bearer(tok.managerB)).expect(404);
      await ctx.http().get(`${API}/orders/${o.id}`).set(bearer(tok.otherOwner)).expect(404);
      await ctx.http().get(`${API}/orders/${o.id}`).set(bearer(tok.kitchenA)).expect(403);
      await ctx.http().get(`${API}/orders`).query({ branchId: fx.branchA }).set(bearer(tok.managerB)).expect(403);
      const list = await ctx.http().get(`${API}/orders`).query({ branchId: fx.branchA, status: 'NEW,CONFIRMED' }).set(bearer(tok.waiterA)).expect(200);
      expect(list.body.data.every((x: { status: string }) => ['NEW', 'CONFIRMED'].includes(x.status))).toBe(true);
      // Another organization's product cannot be ordered.
      const otherMenu = await seedMenu(ctx.prisma, other);
      expect((await post('/orders', dineIn([{ productId: otherMenu.lassi, quantity: '1' }])).expect(400)).body.error.code).toBe('INVALID_PRODUCT');
    });
  });
});
