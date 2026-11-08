import { API, TestContext, createTestApp } from './helpers/app';
import { OrgFixture, bearer, createOrg, tokenFor } from './helpers/fixtures';
import { key } from './helpers/menu';

interface PoItem {
  id: string;
  ingredientId: string;
  quantity: string;
  receivedQuantity: string;
  remainingQuantity: string;
  unitPrice: string;
  lineTotal: string;
  unit: { code: string };
}
interface Po {
  id: string;
  poNumber: string;
  status: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  items: PoItem[];
}
interface Invoice {
  id: string;
  status: string;
  total: string;
  paidAmount: string;
  outstanding: string;
  dueDate: string;
  isOverdue: boolean;
  goodsReceipts: { id: string }[];
}

describe('Purchasing: suppliers, purchase orders, goods received, supplier bills (e2e)', () => {
  let ctx: TestContext;
  let fx: OrgFixture;
  let other: OrgFixture;
  const tok: Record<string, string> = {};
  const ing: Record<string, string> = {};
  let prefix: string;
  let supplierId: string;
  let po: Po;
  const grns: string[] = [];

  const http = () => ctx.http();
  const post = (path: string, body: object, token = tok.inventoryA, idem: string | null = key()) => {
    const r = http().post(`${API}${path}`).set(bearer(token));
    if (idem) r.set('Idempotency-Key', idem);
    return r.send(body);
  };
  const getPo = async (id: string, token = tok.inventoryA) => (await http().get(`${API}/purchase-orders/${id}`).set(bearer(token)).expect(200)).body.data as Po;
  const balance = (ingredientId: string) => ctx.prisma.inventoryBalance.findUniqueOrThrow({ where: { branchId_ingredientId: { branchId: fx.branchA, ingredientId } } });
  const line = (p: Po, ingredientId: string) => p.items.find((i) => i.ingredientId === ingredientId)!;

  beforeAll(async () => {
    ctx = await createTestApp();
    fx = await createOrg(ctx.prisma, 'Purchasing');
    other = await createOrg(ctx.prisma, 'PurchasingOther');
    for (const h of ['owner', 'managerA', 'managerB', 'inventoryA', 'accountant', 'cashierA']) tok[h] = await tokenFor(ctx, fx, h);
    tok.otherOwner = await tokenFor(ctx, other, 'owner');
    const units = await ctx.prisma.unit.findMany();
    const g = units.find((u) => u.code === 'g')!;
    const ml = units.find((u) => u.code === 'ml')!;
    for (const [name, unitId] of [['Paneer', g.id], ['Milk', ml.id], ['Onion', g.id]] as const) {
      ing[name] = (await ctx.prisma.ingredient.create({ data: { organizationId: fx.orgId, name, baseUnitId: unitId } })).id;
    }
    prefix = (await ctx.prisma.branch.findUniqueOrThrow({ where: { id: fx.branchA } })).code.slice(0, 10);
  });
  afterAll(() => ctx.close());

  describe('suppliers', () => {
    it('creates suppliers with a checked GSTIN and unique names', async () => {
      const bad = await post('/suppliers', { name: 'Fresh Farms', gstin: '29ABCDE1234F1Z' }, tok.inventoryA, null).expect(400);
      expect(bad.body.error.code).toBe('VALIDATION_FAILED');
      await post('/suppliers', { name: 'Fresh Farms' }, tok.cashierA, null).expect(403);
      const res = await post('/suppliers', { name: 'Fresh Farms', gstin: '29abcde1234f1z5', phone: '9876543210', paymentTermsDays: 15 }, tok.inventoryA, null).expect(201);
      expect(res.body.data).toEqual(expect.objectContaining({ name: 'Fresh Farms', gstin: '29ABCDE1234F1Z5', stateCode: '29', paymentTermsDays: 15 }));
      supplierId = res.body.data.id;
      const dup = await post('/suppliers', { name: 'fresh farms' }, tok.inventoryA, null).expect(409);
      expect(dup.body.error.code).toBe('DUPLICATE_NAME');
      const list = await http().get(`${API}/suppliers`).set(bearer(tok.managerA)).expect(200);
      expect(list.body.data).toEqual([expect.objectContaining({ id: supplierId, outstanding: '0', overdue: '0' })]);
    });
  });

  describe('purchase orders and partial deliveries', () => {
    it('a draft order is priced on the server and numbered per branch', async () => {
      const res = await post('/purchase-orders', {
        branchId: fx.branchA,
        supplierId,
        items: [
          { ingredientId: ing.Paneer, unit: 'kg', quantity: '10', unitPrice: '400', taxRate: '5' },
          { ingredientId: ing.Milk, unit: 'l', quantity: '20', unitPrice: '56' },
        ],
      }).expect(201);
      po = res.body.data;
      expect(po.poNumber).toMatch(new RegExp(`^${prefix}-PO/\\d{4}/1$`));
      expect([po.status, po.subtotal, po.taxTotal, po.total]).toEqual(['DRAFT', '5120', '200', '5320']);
      expect(line(po, ing.Paneer)).toEqual(expect.objectContaining({ lineTotal: '4200', remainingQuantity: '10', unit: { code: 'kg' } }));

      const mismatch = await post('/purchase-orders', { branchId: fx.branchA, supplierId, items: [{ ingredientId: ing.Milk, unit: 'kg', quantity: '1', unitPrice: '1' }] }).expect(400);
      expect(mismatch.body.error.code).toBe('UNIT_MISMATCH');
      await post('/purchase-orders', { branchId: fx.branchB, supplierId, items: [{ ingredientId: ing.Milk, unit: 'l', quantity: '1', unitPrice: '1' }] }).expect(403);
    });

    it('a draft can be edited; goods cannot be received until the order is approved', async () => {
      const edited = await http()
        .patch(`${API}/purchase-orders/${po.id}`)
        .set(bearer(tok.inventoryA))
        .send({ notes: 'Deliver before 9am', items: [{ ingredientId: ing.Paneer, unit: 'kg', quantity: '10', unitPrice: '400', taxRate: '5' }, { ingredientId: ing.Milk, unit: 'l', quantity: '20', unitPrice: '56' }] })
        .expect(200);
      expect(edited.body.data.notes).toBe('Deliver before 9am');
      po = edited.body.data;

      const early = await post(`/purchase-orders/${po.id}/receipts`, { items: [{ purchaseOrderItemId: line(po, ing.Paneer).id, quantity: '1' }] }).expect(409);
      expect(early.body.error.code).toBe('PO_NOT_RECEIVABLE');
      await http().post(`${API}/purchase-orders/${po.id}/approve`).set(bearer(tok.inventoryA)).expect(403);
      const ok = await http().post(`${API}/purchase-orders/${po.id}/approve`).set(bearer(tok.owner)).expect(200);
      expect(ok.body.data.status).toBe('ORDERED');
      const locked = await http().patch(`${API}/purchase-orders/${po.id}`).set(bearer(tok.inventoryA)).send({ notes: 'x' }).expect(409);
      expect(locked.body.error.code).toBe('PO_NOT_EDITABLE');
    });

    it('a partial delivery adds stock at the purchase price and updates the average cost', async () => {
      // 1 kg already on the shelf at ₹300/kg.
      await post('/inventory/stock-counts', { branchId: fx.branchA, reason: 'Opening', counts: [{ ingredientId: ing.Paneer, quantity: '1', unit: 'kg', unitCost: '300' }] }).expect(201);

      const k = key();
      const body = { items: [{ purchaseOrderItemId: line(po, ing.Paneer).id, quantity: '4' }], notes: 'First lot' };
      const res = await post(`/purchase-orders/${po.id}/receipts`, body, tok.inventoryA, k).expect(201);
      expect(res.body.data).toEqual(expect.objectContaining({ grnNumber: expect.stringMatching(new RegExp(`^${prefix}-GRN/\\d{4}/1$`)), purchaseOrderStatus: 'PARTIALLY_RECEIVED', totalValue: '1600' }));
      grns.push(res.body.data.id);
      // A retried request records nothing new.
      const replay = await post(`/purchase-orders/${po.id}/receipts`, body, tok.inventoryA, k).expect(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body.data.id).toBe(res.body.data.id);

      let bal = await balance(ing.Paneer);
      expect([bal.quantity.toString(), bal.averageCost.toString()]).toEqual(['5000', '0.38']); // (1000×0.30 + 4000×0.40) / 5000
      const p = await getPo(po.id);
      expect(line(p, ing.Paneer)).toEqual(expect.objectContaining({ receivedQuantity: '4', remainingQuantity: '6' }));

      const over = await post(`/purchase-orders/${po.id}/receipts`, { items: [{ purchaseOrderItemId: line(po, ing.Paneer).id, quantity: '6.5' }] }).expect(409);
      expect(over.body.error.code).toBe('OVER_RECEIPT');
      expect(over.body.error.details).toEqual(expect.objectContaining({ remaining: '6' }));

      // The rest arrives at a higher price, with the milk.
      const rest = await post(`/purchase-orders/${po.id}/receipts`, {
        items: [
          { purchaseOrderItemId: line(po, ing.Paneer).id, quantity: '6', unitPrice: '420' },
          { purchaseOrderItemId: line(po, ing.Milk).id, quantity: '20' },
        ],
      }).expect(201);
      expect(rest.body.data.purchaseOrderStatus).toBe('RECEIVED');
      grns.push(rest.body.data.id);
      bal = await balance(ing.Paneer);
      expect([bal.quantity.toString(), bal.averageCost.toString()]).toEqual(['11000', '0.4018']);
      expect((await balance(ing.Milk)).quantity.toString()).toBe('20000');

      const mv = await ctx.prisma.stockMovement.findMany({ where: { branchId: fx.branchA, type: 'PURCHASE_RECEIPT' } });
      expect(mv).toHaveLength(3);
      const done = await post(`/purchase-orders/${po.id}/receipts`, { items: [{ purchaseOrderItemId: line(po, ing.Milk).id, quantity: '1' }] }).expect(409);
      expect(done.body.error.code).toBe('PO_NOT_RECEIVABLE');
    });

    it('lists orders still waiting for delivery and cancels only what has not arrived', async () => {
      const second = (await post('/purchase-orders', { branchId: fx.branchA, supplierId, items: [{ ingredientId: ing.Onion, unit: 'kg', quantity: '25', unitPrice: '30' }] }).expect(201)).body.data as Po;
      await http().post(`${API}/purchase-orders/${second.id}/approve`).set(bearer(tok.owner)).expect(200);
      await post(`/purchase-orders/${second.id}/receipts`, { items: [{ purchaseOrderItemId: second.items[0].id, quantity: '10' }] }).expect(201);

      const pending = await http().get(`${API}/purchase-orders`).query({ branchId: fx.branchA, pending: 'true' }).set(bearer(tok.inventoryA)).expect(200);
      expect(pending.body.data.map((p: Po) => p.id)).toEqual([second.id]);
      expect(pending.body.data[0].items[0].remainingQuantity).toBe('15');

      await http().post(`${API}/purchase-orders/${second.id}/cancel`).set(bearer(tok.inventoryA)).send({ reason: 'Supplier out of onions' }).expect(403);
      const c = await http().post(`${API}/purchase-orders/${second.id}/cancel`).set(bearer(tok.owner)).send({ reason: 'Supplier out of onions' }).expect(200);
      expect(c.body.data).toEqual(expect.objectContaining({ status: 'CANCELLED', cancelReason: 'Supplier out of onions' }));
      expect((await balance(ing.Onion)).quantity.toString()).toBe('10000'); // what arrived stays

      const received = await http().post(`${API}/purchase-orders/${po.id}/cancel`).set(bearer(tok.owner)).send({ reason: 'Too late' }).expect(409);
      expect(received.body.error.code).toBe('PO_NOT_CANCELLABLE');
      const draft = (await post('/purchase-orders', { branchId: fx.branchA, supplierId, items: [{ ingredientId: ing.Onion, unit: 'kg', quantity: '1', unitPrice: '30' }] }).expect(201)).body.data as Po;
      await http().post(`${API}/purchase-orders/${draft.id}/cancel`).set(bearer(tok.inventoryA)).send({ reason: 'Raised by mistake' }).expect(200);
    });

    it('records goods bought without an order', async () => {
      const res = await post('/goods-receipts', { branchId: fx.branchA, supplierId, notes: 'Market run', items: [{ ingredientId: ing.Onion, unit: 'kg', quantity: '5', unitPrice: '40' }] }).expect(201);
      expect(res.body.data).toEqual(expect.objectContaining({ purchaseOrder: null, totalValue: '200' }));
      expect((await balance(ing.Onion)).quantity.toString()).toBe('15000');
      const list = await http().get(`${API}/goods-receipts`).query({ branchId: fx.branchA, purchaseOrderId: po.id }).set(bearer(tok.inventoryA)).expect(200);
      expect(list.body.data.map((g: { id: string }) => g.id).sort()).toEqual([...grns].sort());
    });
  });

  describe('supplier invoices and payments', () => {
    let inv: Invoice;

    it('records the supplier’s bill against its deliveries, once', async () => {
      const body = { branchId: fx.branchA, supplierId, purchaseOrderId: po.id, goodsReceiptIds: grns, invoiceNumber: 'FF/2026/0912', invoiceDate: '2026-11-01', subtotal: '5240.00', taxTotal: '210.00' };
      await post('/supplier-invoices', body, tok.inventoryA).expect(403);
      const res = await post('/supplier-invoices', body, tok.accountant).expect(201);
      inv = res.body.data;
      expect(inv).toEqual(expect.objectContaining({ status: 'UNPAID', total: '5450', outstanding: '5450', dueDate: '2026-11-16T00:00:00.000Z' }));
      expect(inv.goodsReceipts.map((g) => g.id).sort()).toEqual([...grns].sort());

      const dup = await post('/supplier-invoices', body, tok.accountant).expect(409);
      expect(dup.body.error.code).toBe('DUPLICATE_SUPPLIER_INVOICE');
      const again = await post('/supplier-invoices', { ...body, invoiceNumber: 'FF/2026/0913' }, tok.accountant).expect(409);
      expect(again.body.error.code).toBe('GRN_ALREADY_INVOICED');
    });

    it('payments reduce what is owed and can never exceed it', async () => {
      const k = key();
      const p1 = await post('/supplier-payments', { supplierInvoiceId: inv.id, amount: '3000.00', method: 'BANK_TRANSFER', reference: 'UTR 1234' }, tok.accountant, k).expect(201);
      expect(p1.body.data.invoice).toEqual(expect.objectContaining({ status: 'PARTIALLY_PAID', outstanding: '2450' }));
      const replay = await post('/supplier-payments', { supplierInvoiceId: inv.id, amount: '3000.00', method: 'BANK_TRANSFER', reference: 'UTR 1234' }, tok.accountant, k).expect(201);
      expect(replay.body.data.payment.id).toBe(p1.body.data.payment.id);

      const over = await post('/supplier-payments', { supplierInvoiceId: inv.id, amount: '2450.01', method: 'CASH' }, tok.accountant).expect(422);
      expect(over.body.error.code).toBe('AMOUNT_EXCEEDS_OUTSTANDING');
      await post('/supplier-payments', { supplierInvoiceId: inv.id, amount: '10.00', method: 'CASH' }, tok.inventoryA).expect(403);

      // Three clerks pay ₹1,000 at once: only two fit.
      const results = await Promise.all(Array.from({ length: 3 }, () => post('/supplier-payments', { supplierInvoiceId: inv.id, amount: '1000.00', method: 'UPI' }, tok.accountant)));
      expect(results.map((r) => r.status).sort()).toEqual([201, 201, 422]);
      const after = (await http().get(`${API}/supplier-invoices/${inv.id}`).set(bearer(tok.accountant)).expect(200)).body.data as Invoice & { payments: unknown[] };
      expect([after.status, after.paidAmount, after.outstanding, after.payments.length]).toEqual(['PARTIALLY_PAID', '5000', '450', 3]);
      const paid = await ctx.prisma.supplierPayment.aggregate({ where: { supplierInvoiceId: inv.id }, _sum: { amount: true } });
      expect(paid._sum.amount!.toString()).toBe('5000');

      const cancel = await http().post(`${API}/supplier-invoices/${inv.id}/cancel`).set(bearer(tok.accountant)).send({ reason: 'Wrong bill' }).expect(409);
      expect(cancel.body.error.code).toBe('INVOICE_HAS_PAYMENTS');
    });

    it('shows what is owed and overdue per supplier, with a running account', async () => {
      // An old bill that is past its due date.
      const old = (await post('/supplier-invoices', { branchId: fx.branchA, supplierId, invoiceNumber: 'FF/2026/0700', invoiceDate: '2026-07-01', subtotal: '1000.00', taxTotal: '0' }, tok.accountant).expect(201)).body.data as Invoice;
      expect(old.isOverdue).toBe(true);
      const s = (await http().get(`${API}/suppliers/${supplierId}`).set(bearer(tok.accountant)).expect(200)).body.data;
      expect([s.outstanding, s.overdue]).toEqual(['1450', '1000']);
      const overdue = await http().get(`${API}/supplier-invoices`).query({ branchId: fx.branchA, overdue: 'true' }).set(bearer(tok.accountant)).expect(200);
      expect(overdue.body.data.map((i: Invoice) => i.id)).toEqual([old.id]);

      const acct = (await http().get(`${API}/suppliers/${supplierId}/transactions`).set(bearer(tok.accountant)).expect(200)).body.data;
      expect(acct.entries[0]).toEqual(expect.objectContaining({ type: 'INVOICE', reference: 'FF/2026/0700', debit: '1000', balance: '1000' }));
      expect(acct.balance).toBe('1450');
      expect(acct.entries.filter((e: { type: string }) => e.type === 'PAYMENT')).toHaveLength(3);

      const del = await http().delete(`${API}/suppliers/${supplierId}`).set(bearer(tok.inventoryA)).expect(409);
      expect(del.body.error.code).toBe('SUPPLIER_IN_USE');

      // An unpaid bill can be cancelled, which frees nothing it did not hold and removes it from the dues.
      await http().post(`${API}/supplier-invoices/${old.id}/cancel`).set(bearer(tok.accountant)).send({ reason: 'Duplicate of a paid bill' }).expect(200);
      await post('/supplier-payments', { supplierInvoiceId: old.id, amount: '1.00', method: 'CASH' }, tok.accountant).expect(409);
      expect((await http().get(`${API}/suppliers/${supplierId}`).set(bearer(tok.accountant))).body.data.overdue).toBe('0');

      await post('/supplier-payments', { supplierInvoiceId: inv.id, amount: '450.00', method: 'UPI' }, tok.accountant).expect(201);
      const paid = (await http().get(`${API}/supplier-invoices/${inv.id}`).set(bearer(tok.accountant))).body.data as Invoice;
      expect([paid.status, paid.outstanding]).toEqual(['PAID', '0']);
    });
  });

  describe('access and isolation', () => {
    it('other branches and organizations see none of these records', async () => {
      await http().get(`${API}/purchase-orders/${po.id}`).set(bearer(tok.managerB)).expect(404);
      await http().get(`${API}/purchase-orders/${po.id}`).set(bearer(tok.otherOwner)).expect(404);
      await http().get(`${API}/goods-receipts/${grns[0]}`).set(bearer(tok.otherOwner)).expect(404);
      await http().get(`${API}/suppliers/${supplierId}`).set(bearer(tok.otherOwner)).expect(404);
      await http().get(`${API}/purchase-orders`).query({ branchId: fx.branchA }).set(bearer(tok.managerB)).expect(403);
      const foreign = await post('/purchase-orders', { branchId: fx.branchA, supplierId, items: [{ ingredientId: ing.Milk, unit: 'l', quantity: '1', unitPrice: '1' }] }, tok.otherOwner);
      expect([403, 404]).toContain(foreign.status);
      // Every change is in the audit log.
      const actions = (await ctx.prisma.auditLog.findMany({ where: { organizationId: fx.orgId }, select: { action: true } })).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(['supplier.created', 'purchase_order.created', 'purchase_order.approved', 'goods_receipt.created', 'supplier_invoice.created', 'supplier_payment.created', 'purchase_order.cancelled']));
    });
  });
});
