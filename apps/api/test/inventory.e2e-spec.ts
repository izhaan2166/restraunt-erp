import { Prisma } from '@prisma/client';
import { API, TestContext, createTestApp } from './helpers/app';
import { OrgFixture, bearer, createOrg, tokenFor } from './helpers/fixtures';
import { MenuFixture, key, seedMenu } from './helpers/menu';

interface StockRow {
  ingredientId: string;
  name: string;
  unit: string;
  quantity: string;
  minimumLevel: string;
  averageCost: string;
  stockValue: string;
  isLow: boolean;
  isNegative: boolean;
}

describe('Inventory: ingredients, stock ledger, recipes and sales deduction (e2e)', () => {
  let ctx: TestContext;
  let fx: OrgFixture;
  let other: OrgFixture;
  let menu: MenuFixture;
  const tok: Record<string, string> = {};
  const ing: Record<string, string> = {};

  const http = () => ctx.http();
  const post = (path: string, body: object, token = tok.inventoryA, idem: string | null = key()) => {
    const r = http().post(`${API}${path}`).set(bearer(token));
    if (idem) r.set('Idempotency-Key', idem);
    return r.send(body);
  };
  const stock = async (branchId = fx.branchA, token = tok.inventoryA) =>
    (await http().get(`${API}/inventory`).query({ branchId }).set(bearer(token)).expect(200)).body.data as StockRow[];
  const qty = async (name: string, branchId = fx.branchA) => (await stock(branchId)).find((r) => r.ingredientId === ing[name])!.quantity;
  const settings = (body: object) => http().patch(`${API}/branches/${fx.branchA}/settings`).set(bearer(tok.owner)).send(body);
  /** The ledger and the balance must always agree. */
  async function expectLedgerMatches(branchId: string, ingredientId: string) {
    const sum = await ctx.prisma.stockMovement.aggregate({ where: { branchId, ingredientId }, _sum: { quantity: true } });
    const bal = await ctx.prisma.inventoryBalance.findUniqueOrThrow({ where: { branchId_ingredientId: { branchId, ingredientId } } });
    expect(bal.quantity.toString()).toBe((sum._sum.quantity ?? new Prisma.Decimal(0)).toString());
  }
  const consumed = async (orderId: string) => {
    const items = await ctx.prisma.orderItem.findMany({ where: { orderId }, select: { id: true } });
    return ctx.prisma.stockMovement.findMany({ where: { referenceType: 'order_item', referenceId: { in: items.map((i) => i.id) } } });
  };
  const net = (rows: { ingredientId: string; quantity: Prisma.Decimal }[], ingredientId: string) =>
    rows.filter((r) => r.ingredientId === ingredientId).reduce((a, r) => a.add(r.quantity), new Prisma.Decimal(0)).toString();

  /** A paid takeaway; `complete` walks it to COMPLETED. */
  async function takeaway(items: object[], complete = true, token = tok.cashierA) {
    let o = (await post('/orders', { branchId: fx.branchA, orderType: 'TAKEAWAY', customerName: 'Stock test', items }, token).expect(201)).body.data;
    const inv = (await post('/billing/checkout', { orderId: o.id, payments: [] }, token).expect(200)).body.data;
    await post(`/invoices/${inv.id}/payments`, { method: 'UPI', amount: inv.outstanding }, token).expect(201);
    o = (await http().get(`${API}/orders/${o.id}`).set(bearer(token)).expect(200)).body.data;
    o = (await http().post(`${API}/orders/${o.id}/confirm`).set(bearer(token)).send({ version: o.version }).expect(201)).body.data;
    if (complete) {
      o = (await http().post(`${API}/orders/${o.id}/status`).set(bearer(token)).send({ version: o.version, status: 'READY' }).expect(201)).body.data;
      o = (await http().post(`${API}/orders/${o.id}/status`).set(bearer(token)).send({ version: o.version, status: 'PICKED_UP' }).expect(201)).body.data;
      expect(o.status).toBe('COMPLETED');
    }
    return { order: o as { id: string; version: number; status: string; items: { id: string; productName: string }[] }, invoiceId: inv.id as string };
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    fx = await createOrg(ctx.prisma, 'Stock');
    other = await createOrg(ctx.prisma, 'StockOther');
    menu = await seedMenu(ctx.prisma, fx);
    for (const h of ['owner', 'managerA', 'managerB', 'cashierA', 'waiterA', 'kitchenA', 'inventoryA']) tok[h] = await tokenFor(ctx, fx, h);
    tok.otherOwner = await tokenFor(ctx, other, 'owner');
  });
  afterAll(() => ctx.close());

  describe('ingredients and units', () => {
    it('lists the units and keeps stock in the smallest unit of each ingredient', async () => {
      const units = (await http().get(`${API}/units`).set(bearer(tok.waiterA)).expect(200)).body.data as { code: string }[];
      expect(units.map((u) => u.code)).toEqual(expect.arrayContaining(['g', 'kg', 'ml', 'l', 'pc', 'dozen']));

      const bad = await post('/ingredients', { name: 'Paneer', baseUnit: 'kg' }, tok.inventoryA, null).expect(400);
      expect(bad.body.error.code).toBe('INVALID_BASE_UNIT');
      await post('/ingredients', { name: 'Paneer', baseUnit: 'g' }, tok.waiterA, null).expect(403);

      for (const [name, unit] of [['Paneer', 'g'], ['Curd', 'g'], ['Sugar', 'g'], ['Milk', 'ml'], ['Egg', 'pc']] as const) {
        const r = await post('/ingredients', { name, baseUnit: unit, category: 'Dairy' }, tok.inventoryA, null).expect(201);
        expect(r.body.data).toEqual(expect.objectContaining({ name, baseUnit: expect.objectContaining({ code: unit }) }));
        ing[name] = r.body.data.id;
      }
      const dup = await post('/ingredients', { name: 'paneer', baseUnit: 'g' }, tok.inventoryA, null).expect(409);
      expect(dup.body.error.code).toBe('DUPLICATE_NAME');
      const list = await http().get(`${API}/ingredients`).query({ search: 'pan' }).set(bearer(tok.inventoryA)).expect(200);
      expect(list.body.data.map((i: { name: string }) => i.name)).toEqual(['Paneer']);
    });
  });

  describe('opening stock, adjustments and wastage', () => {
    it('a first stock count records opening stock at its cost', async () => {
      const res = await post('/inventory/stock-counts', {
        branchId: fx.branchA,
        reason: 'Opening stock',
        counts: [
          { ingredientId: ing.Curd, quantity: '10', unit: 'kg', unitCost: '60' },
          { ingredientId: ing.Sugar, quantity: '5000', unitCost: '0.045' },
          { ingredientId: ing.Paneer, quantity: '2', unit: 'kg', unitCost: '400' },
          { ingredientId: ing.Milk, quantity: '2', unit: 'l', unitCost: '56' },
        ],
      }).expect(201);
      expect(res.body.data.map((r: { type: string }) => r.type)).toEqual(['OPENING', 'OPENING', 'OPENING', 'OPENING']);
      const curd = (await stock()).find((r) => r.ingredientId === ing.Curd)!;
      expect(curd).toEqual(expect.objectContaining({ unit: 'g', quantity: '10000', averageCost: '0.06', stockValue: '600', isLow: false }));
      expect(await qty('Paneer')).toBe('2000');
    });

    it('refuses to take out more than is in stock; wastage is valued at the average cost', async () => {
      const over = await post('/inventory/adjustments', { branchId: fx.branchA, ingredientId: ing.Milk, quantity: '3', unit: 'l', reason: 'Spilt', direction: 'OUT' }).expect(409);
      expect(over.body.error.code).toBe('INSUFFICIENT_STOCK');
      const mismatch = await post('/inventory/adjustments', { branchId: fx.branchA, ingredientId: ing.Milk, quantity: '3', unit: 'kg', reason: 'Wrong unit', direction: 'IN' }).expect(400);
      expect(mismatch.body.error.code).toBe('UNIT_MISMATCH');

      await post('/inventory/adjustments', { branchId: fx.branchA, ingredientId: ing.Milk, quantity: '500', reason: 'Found in cold room', direction: 'IN' }).expect(201);
      expect(await qty('Milk')).toBe('2500');
      await post('/inventory/wastage', { branchId: fx.branchA, ingredientId: ing.Curd, quantity: '200', reason: 'Turned sour' }, tok.kitchenA).expect(403);
      const w = await post('/inventory/wastage', { branchId: fx.branchA, ingredientId: ing.Curd, quantity: '200', reason: 'Turned sour' }).expect(201);
      expect(w.body.data.wastage).toEqual(expect.objectContaining({ quantity: '200', cost: '12' }));
      expect(await qty('Curd')).toBe('9800');

      const mv = await http().get(`${API}/inventory/movements`).query({ branchId: fx.branchA, ingredientId: ing.Curd }).set(bearer(tok.inventoryA)).expect(200);
      expect(mv.body.data.map((m: { type: string }) => m.type).sort()).toEqual(['OPENING', 'WASTAGE']);
      expect(mv.body.data.find((m: { type: string }) => m.type === 'WASTAGE')).toEqual(expect.objectContaining({ quantity: '-200', balanceAfter: '9800', value: '12', unit: 'g' }));
      await expectLedgerMatches(fx.branchA, ing.Curd);
    });

    it('a recount books only the difference, and the ledger cannot be edited', async () => {
      const res = await post('/inventory/stock-counts', { branchId: fx.branchA, reason: 'Weekly count', counts: [{ ingredientId: ing.Milk, quantity: '2.4', unit: 'l' }] }).expect(201);
      expect(res.body.data[0]).toEqual(expect.objectContaining({ before: '2500', counted: '2400', difference: '-100', type: 'ADJUSTMENT_OUT' }));
      const m = await ctx.prisma.stockMovement.findFirstOrThrow({ where: { ingredientId: ing.Milk } });
      await expect(ctx.prisma.stockMovement.update({ where: { id: m.id }, data: { quantity: 1 } })).rejects.toThrow();
      await expect(ctx.prisma.stockMovement.delete({ where: { id: m.id } })).rejects.toThrow();
    });

    it('concurrent stock changes are applied one after another', async () => {
      const before = new Prisma.Decimal(await qty('Sugar'));
      const res = await Promise.all(
        Array.from({ length: 8 }, (_, n) => post('/inventory/wastage', { branchId: fx.branchA, ingredientId: ing.Sugar, quantity: '10', reason: `Spill ${n}` })),
      );
      expect(res.every((r) => r.status === 201)).toBe(true);
      expect(await qty('Sugar')).toBe(before.sub(80).toString());
      const after = await ctx.prisma.stockMovement.findMany({ where: { ingredientId: ing.Sugar, type: 'WASTAGE' } });
      expect(new Set(after.map((m) => m.balanceAfter.toString())).size).toBe(8);
      await expectLedgerMatches(fx.branchA, ing.Sugar);
    });
  });

  describe('recipes', () => {
    it('stores recipes per product or size and shows the cost of one portion', async () => {
      await http().put(`${API}/recipes/${menu.lassi}`).set(bearer(tok.waiterA)).send({ items: [{ ingredientId: ing.Curd, quantity: '150', unit: 'g' }] }).expect(403);
      const bad = await http().put(`${API}/recipes/${menu.lassi}`).set(bearer(tok.inventoryA)).send({ items: [{ ingredientId: ing.Sugar, quantity: '2', unit: 'pc' }] }).expect(400);
      expect(bad.body.error.code).toBe('UNIT_MISMATCH');

      await http()
        .put(`${API}/recipes/${menu.lassi}`)
        .set(bearer(tok.inventoryA))
        .send({ items: [{ ingredientId: ing.Curd, quantity: '150', unit: 'g' }, { ingredientId: ing.Sugar, quantity: '20', unit: 'g', wastagePercent: '10' }] })
        .expect(200);
      const r = await http().get(`${API}/recipes/${menu.lassi}`).query({ branchId: fx.branchA }).set(bearer(tok.inventoryA)).expect(200);
      expect(r.body.data.items).toEqual([
        expect.objectContaining({ ingredientName: 'Curd', perPortion: '150', estimatedCost: '9' }),
        expect.objectContaining({ ingredientName: 'Sugar', perPortion: '22', estimatedCost: '0.99' }),
      ]);
      expect(r.body.data.estimatedCostPerPortion).toBe('9.99');

      // Paneer tikka: half plate uses the product recipe, the full plate has its own.
      await http().put(`${API}/recipes/${menu.paneer.id}`).set(bearer(tok.inventoryA)).send({ items: [{ ingredientId: ing.Paneer, quantity: '150', unit: 'g' }] }).expect(200);
      await http()
        .put(`${API}/recipes/${menu.paneer.id}`)
        .set(bearer(tok.inventoryA))
        .send({ variantId: menu.paneer.full, items: [{ ingredientId: ing.Paneer, quantity: '0.25', unit: 'kg' }] })
        .expect(200);
      const full = await http().get(`${API}/recipes/${menu.paneer.id}`).query({ variantId: menu.paneer.full }).set(bearer(tok.inventoryA)).expect(200);
      expect(full.body.data.items[0]).toEqual(expect.objectContaining({ quantity: '0.25', unit: 'kg', perPortion: '250' }));

      const inUse = await http().delete(`${API}/ingredients/${ing.Curd}`).set(bearer(tok.inventoryA)).expect(409);
      expect(inUse.body.error.code).toBe('INGREDIENT_IN_USE');
    });
  });

  describe('stock deduction from sales', () => {
    it('a completed order uses up its recipe ingredients exactly once', async () => {
      const [curd, sugar, paneer] = [await qty('Curd'), await qty('Sugar'), await qty('Paneer')].map((v) => new Prisma.Decimal(v));
      const { order } = await takeaway(
        [
          { productId: menu.lassi, quantity: '2' },
          { productId: menu.paneer.id, variantId: menu.paneer.half, quantity: '1' },
          { productId: menu.paneer.id, variantId: menu.paneer.full, quantity: '1' },
        ],
        false,
      );
      // ON_ORDER_COMPLETE (the default): nothing moves while the order is being made.
      expect(await consumed(order.id)).toHaveLength(0);

      let o = (await http().post(`${API}/orders/${order.id}/status`).set(bearer(tok.cashierA)).send({ version: order.version, status: 'READY' }).expect(201)).body.data;
      o = (await http().post(`${API}/orders/${o.id}/status`).set(bearer(tok.cashierA)).send({ version: o.version, status: 'PICKED_UP' }).expect(201)).body.data;
      expect(o.status).toBe('COMPLETED');
      expect(await qty('Curd')).toBe(curd.sub(300).toString());
      expect(await qty('Sugar')).toBe(sugar.sub(44).toString());
      expect(await qty('Paneer')).toBe(paneer.sub(400).toString());
      const rows = await consumed(order.id);
      expect(rows.every((r) => r.type === 'SALE_CONSUMPTION')).toBe(true);
      expect(rows).toHaveLength(4);
      for (const i of ['Curd', 'Sugar', 'Paneer']) await expectLedgerMatches(fx.branchA, ing[i]);
    });

    it('reopening a completed order puts the stock back, completing it again takes it again', async () => {
      const { order } = await takeaway([{ productId: menu.lassi, quantity: '1' }]);
      const curd = new Prisma.Decimal(await qty('Curd'));
      let o = (await http().post(`${API}/orders/${order.id}/reopen`).set(bearer(tok.managerA)).send({ version: order.version, reason: 'Wrong items punched' }).expect(201)).body.data;
      expect(o.status).not.toBe('COMPLETED');
      expect(await qty('Curd')).toBe(curd.add(150).toString());
      expect(net(await consumed(order.id), ing.Curd)).toBe('0');

      expect(o.status).toBe('PICKED_UP');
      o = (await http().post(`${API}/orders/${o.id}/status`).set(bearer(tok.managerA)).send({ version: o.version, status: 'COMPLETED' }).expect(201)).body.data;
      expect(o.status).toBe('COMPLETED');
      expect(await qty('Curd')).toBe(curd.toString());
      expect(net(await consumed(order.id), ing.Curd)).toBe('-150');
      await expectLedgerMatches(fx.branchA, ing.Curd);
    });

    it('a refund with restock returns the credited portion to stock', async () => {
      const { invoiceId } = await takeaway([{ productId: menu.lassi, quantity: '2' }]);
      const inv = (await http().get(`${API}/invoices/${invoiceId}`).set(bearer(tok.managerA)).expect(200)).body.data;
      const noCn = await post(`/invoices/${invoiceId}/refunds`, { paymentId: inv.payments[0].id, amount: '10.00', reason: 'Spoilt', restock: true }, tok.managerA).expect(400);
      expect(noCn.body.error.code).toBe('RESTOCK_NEEDS_CREDIT_NOTE');

      const lassi = inv.items.find((i: { description: string }) => i.description === 'Sweet Lassi');
      const cn = (await http().post(`${API}/invoices/${invoiceId}/credit-notes`).set(bearer(tok.managerA)).send({ reason: 'Returned unopened', lines: [{ invoiceItemId: lassi.id, quantity: '1' }] }).expect(201)).body.data;
      const curd = new Prisma.Decimal(await qty('Curd'));
      const sugar = new Prisma.Decimal(await qty('Sugar'));
      await post(`/invoices/${invoiceId}/refunds`, { paymentId: inv.payments[0].id, amount: cn.creditNotes[0].totalAmount, reason: 'Returned unopened', creditNoteId: cn.creditNotes[0].id, restock: true }, tok.managerA).expect(201);
      expect(await qty('Curd')).toBe(curd.add(150).toString());
      expect(await qty('Sugar')).toBe(sugar.add(22).toString());
      const back = await ctx.prisma.stockMovement.findMany({ where: { referenceType: 'credit_note', referenceId: cn.creditNotes[0].id } });
      expect(back.map((m) => m.type)).toEqual(['SALE_REVERSAL', 'SALE_REVERSAL']);
    });

    it('with ON_ORDER_CONFIRM, sending to the kitchen uses stock and an item voided before cooking gives it back', async () => {
      await http().patch(`${API}/branches/${fx.branchA}/settings`).set(bearer(tok.managerA)).send({ stockDeductionPolicy: 'ON_ORDER_CONFIRM' }).expect(403);
      const s = await settings({ stockDeductionPolicy: 'ON_ORDER_CONFIRM' }).expect(200);
      expect(s.body.data.stockDeductionPolicy).toBe('ON_ORDER_CONFIRM');
      try {
        const curd = new Prisma.Decimal(await qty('Curd'));
        // Not billed yet, so items can still be voided.
        let order = (
          await post('/orders', { branchId: fx.branchA, orderType: 'TAKEAWAY', items: [{ productId: menu.lassi, quantity: '1' }, { productId: menu.paneer.id, variantId: menu.paneer.half, quantity: '1' }] }, tok.cashierA).expect(201)
        ).body.data;
        expect(await qty('Curd')).toBe(curd.toString());
        order = (await http().post(`${API}/orders/${order.id}/confirm`).set(bearer(tok.cashierA)).send({ version: order.version }).expect(201)).body.data;
        expect(await qty('Curd')).toBe(curd.sub(150).toString());

        const lassiItem = order.items.find((i: { productName: string }) => i.productName === 'Sweet Lassi');
        const paneerItem = order.items.find((i: { productName: string }) => i.productName === 'Paneer Tikka');
        // The kitchen starts the paneer; then both are voided.
        const tki = await ctx.prisma.kitchenTicketItem.findFirstOrThrow({ where: { orderItemId: paneerItem.id } });
        await http().patch(`${API}/kot/items/${tki.id}/status`).set(bearer(tok.kitchenA)).send({ status: 'PREPARING' }).expect(200);
        const paneer = new Prisma.Decimal(await qty('Paneer'));
        let o = (await http().get(`${API}/orders/${order.id}`).set(bearer(tok.managerA))).body.data;
        o = (
          await http()
            .patch(`${API}/orders/${order.id}`)
            .set(bearer(tok.managerA))
            .send({ version: o.version, removeItems: [{ itemId: lassiItem.id, reason: 'Customer changed mind' }, { itemId: paneerItem.id, reason: 'Customer changed mind' }] })
            .expect(200)
        ).body.data;
        expect(await qty('Curd')).toBe(curd.toString()); // lassi never made: back in stock
        expect(await qty('Paneer')).toBe(paneer.toString()); // paneer was on the grill: stays used
      } finally {
        await settings({ stockDeductionPolicy: 'ON_ORDER_COMPLETE' }).expect(200);
      }
    });

    it('a branch that forbids negative stock will not send to the kitchen what it cannot make', async () => {
      await settings({ allowNegativeStock: false }).expect(200);
      try {
        const o = (await post('/orders', { branchId: fx.branchA, orderType: 'TAKEAWAY', items: [{ productId: menu.paneer.id, variantId: menu.paneer.full, quantity: '50' }] }, tok.cashierA).expect(201)).body.data;
        const res = await http().post(`${API}/orders/${o.id}/confirm`).set(bearer(tok.cashierA)).send({ version: o.version }).expect(409);
        expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
        expect(res.body.error.details.short).toEqual([expect.objectContaining({ ingredientId: ing.Paneer, name: 'Paneer', required: '12500' })]);
        expect((await ctx.prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('NEW');
      } finally {
        await settings({ allowNegativeStock: true }).expect(200);
      }
      // Allowed again: the sale goes through and stock shows negative so it can be corrected.
      const before = new Prisma.Decimal(await qty('Paneer'));
      await takeaway([{ productId: menu.paneer.id, variantId: menu.paneer.full, quantity: '8' }]);
      const row = (await stock()).find((r) => r.ingredientId === ing.Paneer)!;
      expect(row.quantity).toBe(before.sub(2000).toString());
      expect(row.isNegative).toBe(new Prisma.Decimal(row.quantity).lt(0));
    });
  });

  describe('low-stock alerts', () => {
    it('crossing the minimum level raises one alert and a notification; restocking clears it', async () => {
      await post('/inventory/stock-counts', { branchId: fx.branchA, reason: 'Recount', counts: [{ ingredientId: ing.Milk, quantity: '1000' }] }).expect(201);
      const levels = await http().put(`${API}/inventory/levels`).set(bearer(tok.inventoryA)).send({ branchId: fx.branchA, levels: [{ ingredientId: ing.Milk, minimumLevel: '800' }] }).expect(200);
      expect(levels.body.data.find((r: StockRow) => r.ingredientId === ing.Milk).isLow).toBe(false);

      await post('/inventory/wastage', { branchId: fx.branchA, ingredientId: ing.Milk, quantity: '300', reason: 'Spilt' }).expect(201);
      await post('/inventory/wastage', { branchId: fx.branchA, ingredientId: ing.Milk, quantity: '100', reason: 'Spilt again' }).expect(201);
      const low = (await http().get(`${API}/inventory/low-stock`).query({ branchId: fx.branchA }).set(bearer(tok.managerA)).expect(200)).body.data as StockRow[];
      expect(low.map((r) => r.name)).toContain('Milk');

      const events = await ctx.prisma.realtimeEvent.findMany({ where: { branchId: fx.branchA, topic: 'inventory', entityId: ing.Milk }, orderBy: { pendingId: 'asc' } });
      expect(events.map((e) => e.type)).toEqual(['inventory.low_stock']); // once, not on every further drop
      expect(events[0].payload).toEqual(expect.objectContaining({ name: 'Milk', unit: 'ml', quantity: '700', minimumLevel: '800' }));
      const notes = await ctx.prisma.notification.findMany({ where: { branchId: fx.branchA, type: 'inventory.low_stock' } });
      expect(notes.map((n) => n.title)).toEqual(['Low stock: Milk']);

      await post('/inventory/adjustments', { branchId: fx.branchA, ingredientId: ing.Milk, quantity: '1', unit: 'l', reason: 'Delivery', direction: 'IN' }).expect(201);
      const after = await ctx.prisma.realtimeEvent.findMany({ where: { branchId: fx.branchA, topic: 'inventory', entityId: ing.Milk }, orderBy: { pendingId: 'asc' } });
      expect(after.map((e) => e.type)).toEqual(['inventory.low_stock', 'inventory.restocked']);
    });
  });

  describe('access and isolation', () => {
    it('other branches and organizations cannot see or change this stock', async () => {
      await http().get(`${API}/inventory`).query({ branchId: fx.branchA }).set(bearer(tok.managerB)).expect(403);
      await http().get(`${API}/inventory`).query({ branchId: fx.branchA }).set(bearer(tok.otherOwner)).expect((r) => expect([403, 404]).toContain(r.status));
      await http().get(`${API}/ingredients/${ing.Curd}`).set(bearer(tok.otherOwner)).expect(404);
      await post('/inventory/adjustments', { branchId: fx.branchA, ingredientId: ing.Curd, quantity: '1', reason: 'Nope', direction: 'IN' }, tok.otherOwner).expect((r) => expect([403, 404]).toContain(r.status));
      // Another org's ingredient cannot be used here.
      const foreign = (await post('/ingredients', { name: 'Foreign salt', baseUnit: 'g' }, tok.otherOwner, null).expect(201)).body.data;
      const res = await post('/inventory/adjustments', { branchId: fx.branchA, ingredientId: foreign.id, quantity: '1', reason: 'Nope', direction: 'IN' }).expect(400);
      expect(res.body.error.code).toBe('INVALID_INGREDIENT');
      // Branch B is untouched by everything above.
      expect((await stock(fx.branchB, tok.owner)).every((r) => r.quantity === '0')).toBe(true);
    });
  });
});
