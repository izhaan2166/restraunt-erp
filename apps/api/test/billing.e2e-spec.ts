import { API, TestContext, createTestApp } from './helpers/app';
import { OrgFixture, bearer, createOrg, openShift, tokenFor } from './helpers/fixtures';
import { MenuFixture, addTable, key, seedMenu } from './helpers/menu';

interface Invoice {
  id: string;
  invoiceNumber: string;
  status: string;
  grandTotal: string;
  paymentStatus: string;
  outstanding: string;
  refundDue: string;
  netPaid: string;
  items: { id: string; description: string; quantity: string; lineTotal: string }[];
  payments: { id: string; method: string; amount: string }[];
  creditNotes: { id: string; creditNoteNumber: string; totalAmount: string }[];
  taxSummary: { rate: string; taxableAmount: string; cgstAmount: string; sgstAmount: string }[];
}

describe('Billing: invoices, payments, refunds, credit notes (e2e)', () => {
  let ctx: TestContext;
  let fx: OrgFixture;
  let other: OrgFixture;
  let menu: MenuFixture;
  const tok: Record<string, string> = {};
  let prefix: string;

  const post = (path: string, body: object, token = tok.cashierA, idem: string | null = key()) => {
    const r = ctx.http().post(`${API}${path}`).set(bearer(token));
    if (idem) r.set('Idempotency-Key', idem);
    return r.send(body);
  };
  const invoice = async (id: string, token = tok.cashierA) => (await ctx.http().get(`${API}/invoices/${id}`).set(bearer(token)).expect(200)).body.data as Invoice;
  const table = async (id: string) => ctx.prisma.restaurantTable.findUniqueOrThrow({ where: { id } });

  /** Opens a fresh table, takes a dine-in order and walks it to SERVED. */
  async function servedOrder(items: object[] = [{ productId: menu.lassi, quantity: '2' }, { productId: menu.paneer.id, variantId: menu.paneer.full, quantity: '1' }]) {
    const tableId = await addTable(ctx.prisma, fx, fx.branchA, `B${Math.floor(Math.random() * 1e6)}`);
    await ctx.http().post(`${API}/branches/${fx.branchA}/tables/${tableId}/open`).set(bearer(tok.waiterA)).send({ guestCount: 2 }).expect(201);
    let o = (await post('/orders', { branchId: fx.branchA, orderType: 'DINE_IN', tableId, items }, tok.waiterA).expect(201)).body.data;
    o = (await ctx.http().post(`${API}/orders/${o.id}/confirm`).set(bearer(tok.waiterA)).send({ version: o.version }).expect(201)).body.data;
    o = (await ctx.http().post(`${API}/orders/${o.id}/status`).set(bearer(tok.waiterA)).send({ version: o.version, status: 'SERVED' }).expect(201)).body.data;
    return { order: o as { id: string; version: number; grandTotal: string; status: string }, tableId };
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    fx = await createOrg(ctx.prisma, 'Billing');
    other = await createOrg(ctx.prisma, 'BillingOther');
    menu = await seedMenu(ctx.prisma, fx);
    for (const h of ['owner', 'managerA', 'managerB', 'cashierA', 'waiterA', 'kitchenA', 'accountant']) tok[h] = await tokenFor(ctx, fx, h);
    tok.otherOwner = await tokenFor(ctx, other, 'owner');
    await openShift(ctx, tok.cashierA, fx.branchA); // cash goes into a drawer
    const branch = await ctx.prisma.branch.findUniqueOrThrow({ where: { id: fx.branchA } });
    prefix = branch.code.slice(0, 10);
  });
  afterAll(() => ctx.close());

  describe('checkout', () => {
    it('issues a numbered GST invoice and takes split payments in one step', async () => {
      const { order, tableId } = await servedOrder();
      // 2 × 90 + 320 = 500 → GST 25 → 525
      expect(order.grandTotal).toBe('525');
      const res = await post('/billing/checkout', {
        orderId: order.id,
        payments: [
          { method: 'CASH', amount: '200.00' },
          { method: 'UPI', amount: '325.00', reference: 'UPI-RRN-1234' },
        ],
      }).expect(200);
      const inv = res.body.data as Invoice;
      expect(inv.invoiceNumber).toMatch(new RegExp(`^${prefix}/\\d{4}/\\d+$`));
      expect(inv).toEqual(expect.objectContaining({ status: 'FINALIZED', grandTotal: '525', paymentStatus: 'PAID', outstanding: '0' }));
      expect(inv.payments.map((p) => [p.method, p.amount])).toEqual([['CASH', '200'], ['UPI', '325']]);
      expect(inv.taxSummary).toEqual([expect.objectContaining({ rate: '5', taxableAmount: '500', cgstAmount: '12.5', sgstAmount: '12.5' })]);
      expect(inv.items.map((i) => i.description).sort()).toEqual(['Paneer Tikka (Full)', 'Sweet Lassi']);

      const o = (await ctx.http().get(`${API}/orders/${order.id}`).set(bearer(tok.cashierA)).expect(200)).body.data;
      expect(o).toEqual(expect.objectContaining({ status: 'COMPLETED', paymentStatus: 'PAID', paidAmount: '525' }));
      expect((await table(tableId)).status).toBe('OCCUPIED');
      // The table can now be closed.
      await ctx.http().post(`${API}/branches/${fx.branchA}/tables/${tableId}/close`).set(bearer(tok.waiterA)).expect(200);
    });

    it('invoice numbers are consecutive per branch and financial year', async () => {
      const nums: number[] = [];
      for (let i = 0; i < 3; i++) {
        const { order } = await servedOrder([{ productId: menu.lassi, quantity: '1' }]);
        const inv = (await post('/billing/checkout', { orderId: order.id, payments: [] }).expect(200)).body.data as Invoice;
        nums.push(Number(inv.invoiceNumber.split('/').pop()));
      }
      expect(nums[1] - nums[0]).toBe(1);
      expect(nums[2] - nums[1]).toBe(1);
    });

    it('waiters cannot check out; kitchen staff cannot read bills', async () => {
      const { order } = await servedOrder([{ productId: menu.lassi, quantity: '1' }]);
      await post('/billing/checkout', { orderId: order.id, payments: [] }, tok.waiterA).expect(403);
      const inv = (await post('/billing/checkout', { orderId: order.id, payments: [] }).expect(200)).body.data as Invoice;
      await ctx.http().get(`${API}/invoices/${inv.id}`).set(bearer(tok.kitchenA)).expect(403);
      await ctx.http().get(`${API}/invoices/${inv.id}`).set(bearer(tok.managerB)).expect(404);
      await ctx.http().get(`${API}/invoices/${inv.id}`).set(bearer(tok.otherOwner)).expect(404);
    });
  });

  describe('quick service', () => {
    it('a takeaway paid at the counter completes when it is picked up', async () => {
      let o = (await post('/orders', { branchId: fx.branchA, orderType: 'TAKEAWAY', customerName: 'Meera', items: [{ productId: menu.lassi, quantity: '1' }] }).expect(201)).body.data;
      const inv = (await post('/billing/checkout', { orderId: o.id, payments: [{ method: 'UPI', amount: '95.00' }] }).expect(200)).body.data as Invoice;
      expect(inv.paymentStatus).toBe('PAID');
      o = (await ctx.http().get(`${API}/orders/${o.id}`).set(bearer(tok.cashierA))).body.data;
      expect(o.status).toBe('NEW'); // paid, not yet made
      o = (await ctx.http().post(`${API}/orders/${o.id}/confirm`).set(bearer(tok.cashierA)).send({ version: o.version }).expect(201)).body.data;
      o = (await ctx.http().post(`${API}/orders/${o.id}/status`).set(bearer(tok.cashierA)).send({ version: o.version, status: 'READY' }).expect(201)).body.data;
      o = (await ctx.http().post(`${API}/orders/${o.id}/status`).set(bearer(tok.cashierA)).send({ version: o.version, status: 'PICKED_UP' }).expect(201)).body.data;
      expect(o.status).toBe('COMPLETED');
      expect(o.statusHistory.map((h: { toStatus: string }) => h.toStatus)).toEqual(['NEW', 'CONFIRMED', 'READY', 'PICKED_UP', 'COMPLETED']);
    });
  });

  describe('partial payments and concurrency', () => {
    let inv: Invoice;
    let tableId: string;

    beforeAll(async () => {
      const s = await servedOrder();
      tableId = s.tableId;
      inv = (await post('/invoices', { orderId: s.order.id }).expect(201)).body.data;
    });

    it('an unpaid bill marks the table BILL_PENDING; the order cannot be edited once billed', async () => {
      expect(inv).toEqual(expect.objectContaining({ paymentStatus: 'UNPAID', outstanding: '525' }));
      expect((await table(tableId)).status).toBe('BILL_PENDING');
      const o = (await ctx.http().get(`${API}/orders/${(await ctx.prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).orderId}`).set(bearer(tok.cashierA))).body.data;
      const edit = await ctx.http().patch(`${API}/orders/${o.id}`).set(bearer(tok.cashierA)).send({ version: o.version, addItems: [{ productId: menu.lassi, quantity: '1' }] }).expect(409);
      expect(edit.body.error.code).toBe('ORDER_INVOICED');
      expect((await post('/invoices', { orderId: o.id }).expect(409)).body.error.code).toBe('ALREADY_INVOICED');
    });

    it('takes part payments and refuses to overcharge', async () => {
      const p1 = (await post(`/invoices/${inv.id}/payments`, { method: 'CARD', amount: '300.00' }).expect(201)).body.data as Invoice;
      expect([p1.paymentStatus, p1.outstanding]).toEqual(['PARTIALLY_PAID', '225']);
      const over = await post(`/invoices/${inv.id}/payments`, { method: 'CASH', amount: '225.01' }).expect(422);
      expect(over.body.error).toEqual(expect.objectContaining({ code: 'AMOUNT_EXCEEDS_OUTSTANDING', details: { outstanding: '225.00' } }));
      await post(`/invoices/${inv.id}/payments`, { method: 'CASH', amount: '0' }).expect(400);
    });

    it('a retried payment with the same key is recorded once', async () => {
      const k = key();
      const a = await post(`/invoices/${inv.id}/payments`, { method: 'UPI', amount: '25.00' }, tok.cashierA, k).expect(201);
      const b = await post(`/invoices/${inv.id}/payments`, { method: 'UPI', amount: '25.00' }, tok.cashierA, k).expect(201);
      expect(b.headers['idempotent-replayed']).toBe('true');
      expect(b.body.data.outstanding).toBe(a.body.data.outstanding);
      expect(await ctx.prisma.payment.count({ where: { allocations: { some: { invoiceId: inv.id } }, method: 'UPI' } })).toBe(1);
    });

    it('simultaneous payments for the full balance: exactly one succeeds', async () => {
      const results = await Promise.all(Array.from({ length: 5 }, () => post(`/invoices/${inv.id}/payments`, { method: 'CASH', amount: '200.00' })));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 422)).toHaveLength(4);
      const after = await invoice(inv.id);
      expect([after.paymentStatus, after.outstanding, after.netPaid]).toEqual(['PAID', '0', '525']);
      expect((await table(tableId)).status).toBe('OCCUPIED');
      inv = after;
    });

    it('the database refuses to change a finalized invoice', async () => {
      await expect(ctx.prisma.invoice.update({ where: { id: inv.id }, data: { grandTotal: '1' } })).rejects.toThrow(/cannot be modified/);
      await expect(ctx.prisma.invoiceItem.update({ where: { id: inv.items[0].id }, data: { lineTotal: '1' } })).rejects.toThrow(/cannot be changed/);
      await expect(ctx.prisma.invoice.delete({ where: { id: inv.id } })).rejects.toThrow(/cannot be deleted/);
    });
  });

  describe('credit notes and refunds', () => {
    let inv: Invoice;

    beforeAll(async () => {
      const { order } = await servedOrder();
      inv = (await post('/billing/checkout', { orderId: order.id, payments: [{ method: 'CARD', amount: '525.00' }] }).expect(200)).body.data;
    });

    it('a credit note for one returned lassi reduces the bill and shows the refund due', async () => {
      const lassi = inv.items.find((i) => i.description === 'Sweet Lassi')!;
      await ctx.http().post(`${API}/invoices/${inv.id}/credit-notes`).set(bearer(tok.cashierA)).send({ reason: 'Spoilt', lines: [{ invoiceItemId: lassi.id, quantity: '1' }] }).expect(403);
      const res = await ctx
        .http()
        .post(`${API}/invoices/${inv.id}/credit-notes`)
        .set(bearer(tok.managerA))
        .send({ reason: 'Spoilt lassi', lines: [{ invoiceItemId: lassi.id, quantity: '1' }] })
        .expect(201);
      const after = res.body.data as Invoice;
      expect(after.creditNotes).toHaveLength(1);
      // one lassi = 90 + 4.50 GST
      expect(after.creditNotes[0]).toEqual(expect.objectContaining({ totalAmount: '94.5', cgstAmount: '2.25', sgstAmount: '2.25' }));
      expect(after.creditNotes[0].creditNoteNumber).toMatch(new RegExp(`^${prefix}-CN/\\d{4}/\\d+$`));
      expect([after.refundDue, after.outstanding, after.grandTotal]).toEqual(['94.5', '0', '525']);

      const tooMany = await ctx
        .http()
        .post(`${API}/invoices/${inv.id}/credit-notes`)
        .set(bearer(tok.managerA))
        .send({ reason: 'Again', lines: [{ invoiceItemId: lassi.id, quantity: '2' }] })
        .expect(422);
      expect(tooMany.body.error.code).toBe('EXCEEDS_INVOICED_QUANTITY');
      inv = after;
    });

    it('a cashier’s refund waits for manager approval; the requester cannot approve it', async () => {
      const r = await post(`/invoices/${inv.id}/refunds`, {
        paymentId: inv.payments[0].id,
        amount: '94.50',
        reason: 'Spoilt lassi',
        creditNoteId: inv.creditNotes[0].id,
      }).expect(201);
      expect(r.body.data).toEqual(expect.objectContaining({ status: 'PENDING', method: 'CARD', amount: '94.5' }));
      expect((await invoice(inv.id)).refundDue).toBe('94.5'); // nothing paid out yet
      await ctx.http().post(`${API}/refunds/${r.body.data.id}/approve`).set(bearer(tok.cashierA)).expect(403);
      const pending = await ctx.http().get(`${API}/refunds`).query({ branchId: fx.branchA, status: 'PENDING' }).set(bearer(tok.managerA)).expect(200);
      expect(pending.body.data.map((x: { id: string }) => x.id)).toContain(r.body.data.id);
      const ok = await ctx.http().post(`${API}/refunds/${r.body.data.id}/approve`).set(bearer(tok.managerA)).expect(200);
      expect(ok.body.data).toEqual(expect.objectContaining({ status: 'COMPLETED', approvedById: fx.users.managerA.id }));
      await ctx.http().post(`${API}/refunds/${r.body.data.id}/approve`).set(bearer(tok.managerA)).expect(409);
      const after = await invoice(inv.id);
      expect([after.paymentStatus, after.refundDue, after.netPaid]).toEqual(['PARTIALLY_REFUNDED', '0', '430.5']);
    });

    it('refunds never exceed the original payment or the credit note', async () => {
      const over = await post(`/invoices/${inv.id}/refunds`, { paymentId: inv.payments[0].id, amount: '431.00', reason: 'Too much' }, tok.managerA).expect(422);
      expect(over.body.error.code).toBe('REFUND_EXCEEDS_PAYMENT');
      const cn = await post(`/invoices/${inv.id}/refunds`, { paymentId: inv.payments[0].id, amount: '1.00', reason: 'More', creditNoteId: inv.creditNotes[0].id }, tok.managerA).expect(422);
      expect(cn.body.error.code).toBe('REFUND_EXCEEDS_CREDIT_NOTE');
    });

    it('cancelling an invoice needs its payments refunded first, then credits the rest', async () => {
      const blocked = await ctx.http().post(`${API}/invoices/${inv.id}/cancel`).set(bearer(tok.managerA)).send({ reason: 'Wrong table billed' }).expect(409);
      expect(blocked.body.error.code).toBe('INVOICE_HAS_PAYMENTS');
      await post(`/invoices/${inv.id}/refunds`, { paymentId: inv.payments[0].id, amount: '430.50', reason: 'Wrong table billed' }, tok.managerA).expect(201);
      const res = await ctx.http().post(`${API}/invoices/${inv.id}/cancel`).set(bearer(tok.managerA)).send({ reason: 'Wrong table billed' }).expect(200);
      const cancelled = res.body.data as Invoice;
      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.creditNotes).toHaveLength(2);
      const credited = cancelled.creditNotes.reduce((a, c) => a + Number(c.totalAmount), 0);
      expect(credited).toBeCloseTo(525, 2);
      expect(cancelled.paymentStatus).toBe('REFUNDED');
    });
  });

  describe('re-billing after a cancelled invoice', () => {
    it('the order can be corrected and billed again under a new number', async () => {
      const { order } = await servedOrder([{ productId: menu.lassi, quantity: '1' }]);
      const first = (await post('/invoices', { orderId: order.id }).expect(201)).body.data as Invoice;
      await ctx.http().post(`${API}/invoices/${first.id}/cancel`).set(bearer(tok.managerA)).send({ reason: 'Missed an item' }).expect(200);
      const o = (await ctx.http().get(`${API}/orders/${order.id}`).set(bearer(tok.waiterA))).body.data;
      await ctx.http().patch(`${API}/orders/${order.id}`).set(bearer(tok.waiterA)).send({ version: o.version, addItems: [{ productId: menu.lassi, quantity: '1' }] }).expect(200);
      const second = (await post('/invoices', { orderId: order.id }).expect(201)).body.data as Invoice;
      expect(second.invoiceNumber).not.toBe(first.invoiceNumber);
      expect(second.grandTotal).toBe('189');
    });
  });

  describe('branch tax settings', () => {
    it('tax-inclusive prices with service charge and rupee rounding', async () => {
      await ctx.prisma.branchSettings.create({
        data: { branchId: fx.branchB, organizationId: fx.orgId, taxPricingMode: 'INCLUSIVE', serviceChargePercent: '10', invoicePrefix: 'PUNE' },
      });
      const tableId = await addTable(ctx.prisma, fx, fx.branchB, 'P1');
      await ctx.http().post(`${API}/branches/${fx.branchB}/tables/${tableId}/open`).set(bearer(tok.managerB)).send({ guestCount: 1 }).expect(201);
      const o = (await post('/orders', { branchId: fx.branchB, orderType: 'DINE_IN', tableId, items: [{ productId: menu.lassi, quantity: '1' }] }, tok.managerB).expect(201)).body.data;
      // ₹90 incl. 5% → taxable 85.71, GST 4.29; service charge 10% of 85.71 = 8.57, GST 0.21 + 0.21; 98.99 → 99
      expect([o.taxableAmount, o.serviceCharge, o.taxTotal, o.grandTotal, o.roundOff]).toEqual(['94.28', '8.57', '4.71', '99', '0.01']);
      const inv = (await post('/invoices', { orderId: o.id, buyerGstin: '29aabca1234f1z5', buyerName: 'Acme' }, tok.managerB).expect(201)).body.data;
      expect(inv.invoiceNumber).toMatch(/^PUNE\//);
      expect(inv.buyerGstin).toBe('29AABCA1234F1Z5');
      expect(inv.items.map((i: { description: string }) => i.description)).toEqual(['Sweet Lassi', 'Service charge 10% (GST 5%)']);
      await post('/invoices', { orderId: o.id, buyerGstin: 'NOT-A-GSTIN' }, tok.managerB).expect(400);
    });
  });
});
