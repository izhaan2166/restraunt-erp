import { Prisma } from '@prisma/client';
import { API, TestContext, binary, createTestApp } from './helpers/app';
import { OrgFixture, bearer, createOrg, openShift, tokenFor } from './helpers/fixtures';
import { MenuFixture, key, seedMenu } from './helpers/menu';

const istDate = (daysAgo = 0) => new Date(Date.now() + 5.5 * 3600_000 - daysAgo * 86_400_000).toISOString().slice(0, 10);
/**
 * Builds a real day of trade in branch A (and a little in branch B) through the API, then checks
 * that every report and the dashboard agree with each other and with the database.
 *
 * Branch A, GST 5% exclusive, rounded to the rupee:
 *  1. 2 × Sweet Lassi (90) + Paneer Tikka half (180) → 360 + 18 GST = 378, UPI, completed
 *     (recipe: 200 ml milk at 0.06/ml per lassi → recipe cost 24.00)
 *  2. Veg Thali (250) − 50 fixed discount by the manager → 200 + 10 GST = 210, cash
 *  3. Sweet Lassi (90) → 94.50 → 95 billed, UPI; then credited (90 + 4.50) and 94.50 refunded
 *  4. Sweet Lassi, cancelled before billing
 *  Wastage 500 ml milk (30.00); expenses 1180 (GST 180) + 500.
 */
describe('Dashboard and reports (e2e)', () => {
  let ctx: TestContext;
  let fx: OrgFixture;
  let other: OrgFixture;
  let menu: MenuFixture;
  const tok: Record<string, string> = {};
  let milk: string;
  let invoice1: string;
  const today = istDate();
  const q = { branchId: '', from: today, to: today };

  const http = () => ctx.http();
  const post = (path: string, body: object, token: string, idem: string | null = key()) => {
    const r = http().post(`${API}${path}`).set(bearer(token));
    if (idem) r.set('Idempotency-Key', idem);
    return r.send(body);
  };
  const get = (path: string, query: object, token: string) => http().get(`${API}${path}`).query(query).set(bearer(token));
  const report = async (name: string, token = tok.owner, query: object = q) => (await get(`/reports/${name}`, query, token).expect(200)).body.data;

  async function order(items: object[], branchId = fx.branchA, token = tok.cashierA) {
    return (await post('/orders', { branchId, orderType: 'TAKEAWAY', customerName: 'Report test', items }, token).expect(201)).body.data as { id: string; version: number };
  }
  async function bill(orderId: string, method: string, token = tok.cashierA) {
    const inv = (await post('/billing/checkout', { orderId, payments: [] }, token).expect(200)).body.data;
    await post(`/invoices/${inv.id}/payments`, { method, amount: inv.outstanding }, token).expect(201);
    return (await get(`/invoices/${inv.id}`, {}, token).expect(200)).body.data;
  }
  async function walk(orderId: string, token = tok.cashierA) {
    let o = (await get(`/orders/${orderId}`, {}, token).expect(200)).body.data;
    o = (await http().post(`${API}/orders/${o.id}/confirm`).set(bearer(token)).send({ version: o.version }).expect(201)).body.data;
    o = (await http().post(`${API}/orders/${o.id}/status`).set(bearer(token)).send({ version: o.version, status: 'READY' }).expect(201)).body.data;
    o = (await http().post(`${API}/orders/${o.id}/status`).set(bearer(token)).send({ version: o.version, status: 'PICKED_UP' }).expect(201)).body.data;
    expect(o.status).toBe('COMPLETED');
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    fx = await createOrg(ctx.prisma, 'Reports');
    other = await createOrg(ctx.prisma, 'ReportsOther');
    menu = await seedMenu(ctx.prisma, fx);
    for (const h of ['owner', 'accountant', 'managerA', 'managerB', 'cashierA', 'cashierB', 'waiterA', 'inventoryA']) tok[h] = await tokenFor(ctx, fx, h);
    tok.otherOwner = await tokenFor(ctx, other, 'owner');
    q.branchId = fx.branchA;
    await openShift(ctx, tok.cashierA, fx.branchA);

    milk = (await post('/ingredients', { name: 'Milk', baseUnit: 'ml', category: 'Dairy' }, tok.inventoryA, null).expect(201)).body.data.id;
    await post('/inventory/stock-counts', { branchId: fx.branchA, reason: 'Opening stock', counts: [{ ingredientId: milk, quantity: '10', unit: 'l', unitCost: '60' }] }, tok.inventoryA).expect(201);
    await http().put(`${API}/inventory/levels`).set(bearer(tok.inventoryA)).send({ branchId: fx.branchA, levels: [{ ingredientId: milk, minimumLevel: '10000' }] }).expect(200);
    await http().put(`${API}/recipes/${menu.lassi}`).set(bearer(tok.inventoryA)).send({ items: [{ ingredientId: milk, quantity: '200', unit: 'ml' }] }).expect(200);

    // 1. Paid by UPI and completed: uses 400 ml milk.
    const o1 = await order([{ productId: menu.lassi, quantity: '2' }, { productId: menu.paneer.id, variantId: menu.paneer.half, quantity: '1' }]);
    invoice1 = (await bill(o1.id, 'UPI')).id;
    await walk(o1.id);

    // 2. A manager's fixed discount, paid in cash.
    let o2 = await order([{ productId: menu.thali, quantity: '1', modifiers: [{ modifierId: menu.roti }] }]);
    o2 = (await http().post(`${API}/orders/${o2.id}/discounts`).set(bearer(tok.managerA)).send({ scope: 'ORDER', type: 'FIXED', value: '50', reason: 'Regular guest', version: o2.version }).expect(201)).body.data;
    const inv2 = await bill(o2.id, 'CASH');
    expect(inv2.grandTotal).toBe('210');

    // 3. Billed, then credited and refunded.
    const o3 = await order([{ productId: menu.lassi, quantity: '1' }]);
    const inv3 = await bill(o3.id, 'UPI');
    expect(inv3.grandTotal).toBe('95');
    const cn = (await post(`/invoices/${inv3.id}/credit-notes`, { reason: 'Spilt', lines: [{ invoiceItemId: inv3.items[0].id, quantity: '1' }] }, tok.managerA, null).expect(201)).body.data;
    await post(`/invoices/${inv3.id}/refunds`, { paymentId: inv3.payments[0].id, amount: '94.50', reason: 'Spilt', creditNoteId: cn.creditNotes[0].id }, tok.managerA).expect(201);

    // 4. Cancelled before billing.
    const o4 = await order([{ productId: menu.lassi, quantity: '1' }]);
    await http().post(`${API}/orders/${o4.id}/cancel`).set(bearer(tok.managerA)).send({ version: o4.version, reason: 'Guest left' }).expect(201);

    // Branch B: one UPI sale.
    const b1 = await order([{ productId: menu.lassi, quantity: '1' }], fx.branchB, tok.cashierB);
    await bill(b1.id, 'UPI', tok.cashierB);

    await post('/inventory/wastage', { branchId: fx.branchA, ingredientId: milk, quantity: '500', reason: 'Turned sour' }, tok.inventoryA).expect(201);
    const elec = (await post('/expense-categories', { name: 'Electricity' }, tok.accountant, null).expect(201)).body.data.id;
    const gas = (await post('/expense-categories', { name: 'Gas' }, tok.accountant, null).expect(201)).body.data.id;
    const exp = { branchId: fx.branchA, expenseDate: today, description: 'Bill' };
    await post('/expenses', { ...exp, categoryId: elec, amount: '1180.00', taxAmount: '180.00', paymentMethod: 'BANK_TRANSFER' }, tok.accountant).expect(201);
    await post('/expenses', { ...exp, categoryId: gas, amount: '500.00', paymentMethod: 'CASH' }, tok.accountant).expect(201);
  });
  afterAll(() => ctx.close());

  it('sales: gross, discounts, credit notes, net sales, GST and collections reconcile', async () => {
    const s = await report('sales');
    expect(s.summary).toEqual(
      expect.objectContaining({
        invoices: 3,
        grossSales: '700.00',
        discounts: '50.00',
        taxableSales: '650.00',
        creditNotes: '90.00',
        netSales: '560.00',
        cgst: '14.00',
        sgst: '14.00',
        netTax: '28.00',
        netBilled: '588.50',
        collected: '683.00',
        refunded: '94.50',
        netCollected: '588.50',
      }),
    );
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]).toEqual(expect.objectContaining({ period: today, netSales: '560.00' }));

    // Same figures straight from the tables.
    const where = { branchId: fx.branchA, organizationId: fx.orgId };
    const inv = await ctx.prisma.invoice.aggregate({ where: { ...where, status: { in: ['FINALIZED', 'CANCELLED'] } }, _sum: { taxableAmount: true, grandTotal: true } });
    const cn = await ctx.prisma.creditNote.aggregate({ where, _sum: { taxableAmount: true, totalAmount: true } });
    expect(new Prisma.Decimal(inv._sum.taxableAmount!).sub(cn._sum.taxableAmount!).toFixed(2)).toBe(s.summary.netSales);
    const pay = await ctx.prisma.payment.aggregate({ where: { ...where, status: 'COMPLETED' }, _sum: { amount: true } });
    expect(pay._sum.amount!.toFixed(2)).toBe(s.summary.collected);

    const weeks = await report('sales', tok.owner, { ...q, from: istDate(13), groupBy: 'week' });
    expect(weeks.rows.length).toBeGreaterThanOrEqual(2);
    expect(new Date(`${weeks.rows[0].period}T00:00:00Z`).getUTCDay()).toBe(1);
    const days = await report('sales', tok.owner, { ...q, from: istDate(2) });
    expect(days.rows.map((r: { period: string }) => r.period)).toEqual([istDate(2), istDate(1), today]);
    expect(days.rows[0].netSales).toBe('0.00');
  });

  it('products and categories add up to net sales', async () => {
    const p = await report('products');
    const by = Object.fromEntries(p.rows.map((r: { product: string }) => [r.product, r]));
    expect(by['Sweet Lassi']).toEqual(expect.objectContaining({ quantity: '2', netSales: '180.00', credited: '90.00' }));
    expect(by['Paneer Tikka']).toEqual(expect.objectContaining({ quantity: '1', netSales: '180.00' }));
    expect(by['Veg Thali']).toEqual(expect.objectContaining({ quantity: '1', netSales: '200.00', discounts: '50.00' }));
    expect(p.summary.netSales).toBe('560.00');
    const c = await report('categories');
    expect(c.rows).toHaveLength(1);
    expect(c.rows[0]).toEqual(expect.objectContaining({ netSales: '560.00', products: 3, share: '100.00' }));
  });

  it('GST by rate and HSN, net of credit notes', async () => {
    const g = await report('gst', tok.accountant);
    expect(g.summary).toEqual(expect.objectContaining({ netTaxableValue: '560.00', cgst: '14.00', sgst: '14.00', igst: '0.00', netTax: '28.00' }));
    expect(g.byRate).toEqual([expect.objectContaining({ rate: '5', taxable: '650.00', cgst: '16.25', sgst: '16.25', creditedTaxable: '90.00', creditedTax: '4.50', netTaxable: '560.00', netTax: '28.00' })]);
    expect(g.byHsn).toEqual([expect.objectContaining({ hsn: '996331', quantity: '4', taxable: '560.00', tax: '28.00' })]);
    expect(g.byGstin[0]).toEqual(expect.objectContaining({ netTaxable: '560.00' }));
    await get('/reports/gst', q, tok.managerA).expect(403);
  });

  it('discounts, refunds, cancellations and payments', async () => {
    const d = await report('discounts');
    expect(d.summary).toEqual(expect.objectContaining({ discountedInvoices: 1, discounts: '50.00', grossSales: '700.00' }));
    expect(d.byUser).toEqual([expect.objectContaining({ count: 1, amount: '50.00' })]);
    expect(d.invoices[0]).toEqual(expect.objectContaining({ discount: '50.00', reason: 'Regular guest' }));

    const r = await report('refunds');
    expect(r.summary).toEqual(expect.objectContaining({ completed: 1, completedAmount: '94.50', pending: 0, creditNotes: 1, creditNoteAmount: '94.50' }));
    expect(r.rows[0]).toEqual(expect.objectContaining({ method: 'UPI', amount: '94.50', status: 'COMPLETED', reason: 'Spilt' }));

    const c = await report('cancellations');
    expect(c.summary).toEqual(expect.objectContaining({ cancelledOrders: 1, cancelledOrderValue: '94.50', afterKitchen: 0 }));
    expect(c.orders[0]).toEqual(expect.objectContaining({ reason: 'Guest left' }));

    const y = await report('payments');
    const m = Object.fromEntries(y.byMethod.map((x: { method: string }) => [x.method, x]));
    expect(m.UPI).toEqual(expect.objectContaining({ payments: 2, received: '473.00', refunded: '94.50', net: '378.50' }));
    expect(m.CASH).toEqual(expect.objectContaining({ payments: 1, received: '210.00', net: '210.00' }));
    expect(y.summary.netCollected).toBe('588.50');
  });

  it('inventory: opening + received − used − wasted + adjusted = closing, with values', async () => {
    const inv = await report('inventory');
    const row = inv.rows.find((x: { ingredientId: string }) => x.ingredientId === milk);
    expect(row).toEqual(expect.objectContaining({ unit: 'ml', opening: '0', adjusted: '10000', consumed: '400', wasted: '500', closing: '9100', consumedValue: '24.00', wastedValue: '30.00' }));
    const bal = await ctx.prisma.inventoryBalance.findFirstOrThrow({ where: { branchId: fx.branchA, ingredientId: milk } });
    expect(bal.quantity.toString()).toBe(row.closing);
    const w = await report('wastage', tok.inventoryA);
    expect(w.summary).toEqual({ records: 1, cost: '30.00' });
  });

  it('expenses and estimated profit', async () => {
    const e = await report('expenses', tok.accountant);
    expect(e.summary).toEqual(expect.objectContaining({ count: 2, total: '1680.00', tax: '180.00' }));
    expect(e.byCategory.map((x: { category: string }) => x.category)).toEqual(['Electricity', 'Gas']);

    const pl = await report('profit-loss', tok.accountant);
    expect(pl.summary).toEqual(expect.objectContaining({ netSales: '560.00', costOfGoodsSold: '24.00', grossProfit: '536.00', wastage: '30.00', expenses: '1680.00', estimatedProfit: '-1174.00', gstCollected: '28.00' }));
    expect(pl.statement.find((l: { key: string }) => l.key === 'estimatedProfit').amount).toBe('-1174.00');
    await get('/reports/profit-loss', q, tok.managerA).expect(403);
  });

  it('branch and employee performance', async () => {
    const b = await report('branches', tok.owner, { from: today, to: today });
    const by = Object.fromEntries(b.rows.map((r: { branchId: string }) => [r.branchId, r]));
    expect(by[fx.branchA]).toEqual(expect.objectContaining({ orders: 4, cancelledOrders: 1, invoices: 3, netSales: '560.00' }));
    expect(by[fx.branchB]).toEqual(expect.objectContaining({ invoices: 1, netSales: '90.00' }));
    expect(b.summary.netSales).toBe('650.00');

    const e = await report('employees', tok.managerA);
    const name = (h: string) => e.rows.find((r: { userId: string }) => r.userId === fx.users[h].id);
    expect(name('cashierA')).toEqual(expect.objectContaining({ ordersTaken: 4, billsRaised: 3, amountCollected: '683.00' }));
    expect(name('managerA')).toEqual(expect.objectContaining({ discountsGiven: 1, discountAmount: '50.00', refundAmount: '94.50', ordersCancelled: 1, itemsCancelled: 0 }));
  });

  it('the dashboard matches the reports and hides what the viewer may not see', async () => {
    const d = (await get('/dashboard', { branchId: fx.branchA }, tok.owner).expect(200)).body.data;
    expect(d).toEqual(expect.objectContaining({ range: 'today', from: today, to: today, expenses: '1680.00', estimatedProfit: '-1174.00', hidden: [] }));
    expect(d.sales).toEqual(expect.objectContaining({ totalSales: '588.50', grossRevenue: '700.00', netRevenue: '560.00', bills: 3, averageOrderValue: '227.67', netCollected: '588.50' }));
    expect(d.orders).toEqual({ total: 4, completed: 1, cancelled: 1, pending: 2 });
    expect(d.bestSellers[0]).toEqual(expect.objectContaining({ name: 'Sweet Lassi', quantity: '2' }));
    expect(d.lowStock).toEqual([expect.objectContaining({ ingredientId: milk, quantity: '9100', minimumLevel: '10000' })]);
    expect(d.recentTransactions).toHaveLength(4);
    expect(d.recentTransactions[0]).toEqual(expect.objectContaining({ type: 'REFUND', amount: '94.50' }));
    expect(d.paymentMethods.map((m: { method: string }) => m.method).sort()).toEqual(['CASH', 'UPI']);

    const all = (await get('/dashboard', { range: 'this_month' }, tok.owner).expect(200)).body.data;
    expect(all.branchPerformance.map((b: { branchId: string }) => b.branchId).sort()).toEqual([fx.branchA, fx.branchB].sort());
    expect(all.sales.netRevenue).toBe('650.00');

    const mgr = (await get('/dashboard', {}, tok.managerA).expect(200)).body.data;
    expect(mgr.branches.map((b: { id: string }) => b.id)).toEqual([fx.branchA]);
    expect(mgr).toEqual(expect.objectContaining({ expenses: null, estimatedProfit: null }));
    expect(mgr.hidden).toEqual(['expenses', 'estimatedProfit']);
    expect((await get('/dashboard', { range: 'yesterday', branchId: fx.branchA }, tok.owner).expect(200)).body.data.sales.netRevenue).toBe('0.00');
    expect((await get('/dashboard', { range: 'custom' }, tok.owner).expect(400)).body.error.code).toBe('RANGE_REQUIRED');
    await get('/dashboard', {}, tok.waiterA).expect(403);
  });

  it('keeps branches and organizations apart', async () => {
    await get('/reports/sales', q, tok.managerB).expect(404);
    const b = await report('sales', tok.managerB, { from: today, to: today });
    expect(b.branches.map((x: { id: string }) => x.id)).toEqual([fx.branchB]);
    expect(b.summary.netSales).toBe('90.00');
    await get('/reports/sales', q, tok.otherOwner).expect(404);
    const o = await report('sales', tok.otherOwner, { from: today, to: today });
    expect(o.summary.netSales).toBe('0.00');
    await get('/reports/purchases', q, tok.waiterA).expect(403);
    await get('/reports/purchases', q, tok.accountant).expect(200);
    expect((await get('/reports/sales', { ...q, from: istDate(-1) }, tok.owner).expect(400)).body.error.code).toBe('INVALID_RANGE');
    expect((await get('/reports/sales', { ...q, from: '2019-01-01' }, tok.owner).expect(400)).body.error.code).toBe('RANGE_TOO_LONG');
  });

  it('exports CSV and PDF, and prints the invoice', async () => {
    const csv = await get('/reports/sales', { ...q, format: 'csv' }, tok.owner).expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['content-disposition']).toContain(`sales_${today}_${today}.csv`);
    expect(csv.text).toContain('Net sales (excl. GST),560.00');
    expect(csv.text).toContain(`${today},3,700.00,50.00`);

    const table = (await get('/reports/sales', { ...q, format: 'table' }, tok.owner).expect(200)).body.data;
    expect(table.summary).toContainEqual(expect.objectContaining({ key: 'netSales', label: 'Net sales (excl. GST)', value: '560.00', type: 'money' }));
    expect(table.tables[0].columns[0]).toEqual(expect.objectContaining({ key: 'period' }));

    for (const name of ['sales', 'products', 'gst', 'profit-loss', 'employees', 'inventory', 'cancellations']) {
      const pdf = await get(`/reports/${name}`, { ...q, format: 'pdf' }, tok.owner).buffer(true).parse(binary).expect(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    }
    const inv = await http().get(`${API}/invoices/${invoice1}/pdf`).set(bearer(tok.cashierA)).buffer(true).parse(binary).expect(200);
    expect(inv.headers['content-type']).toBe('application/pdf');
    expect((inv.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    await http().get(`${API}/invoices/${invoice1}/pdf`).set(bearer(tok.cashierB)).expect(404);
  });
});
