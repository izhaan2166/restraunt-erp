import { API, TestContext, createTestApp } from './helpers/app';
import { OrgFixture, bearer, createOrg, openShift, tokenFor } from './helpers/fixtures';
import { MenuFixture, addTable, key, seedMenu } from './helpers/menu';

const istDate = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

interface Order {
  id: string;
  version: number;
  status: string;
  grandTotal: string;
  items: { id: string; productName: string; kitchenStatus: string }[];
}
interface Ticket {
  id: string;
  order: { id: string };
  items: { id: string; status: string }[];
}

/**
 * The release gate: the spec's whole dine-in story in one pass, then the failure modes that
 * matter most at a busy counter (two devices editing one order, double taps, retries over a bad
 * network, two cashiers billing one table, every branch trading at once). Every step goes
 * through the real HTTP API with real roles.
 */
describe('Critical flows (e2e)', () => {
  let ctx: TestContext;
  let fx: OrgFixture;
  let menu: MenuFixture;
  const tok: Record<string, string> = {};
  const http = () => ctx.http();
  const post = (path: string, body: object, token: string, idem: string | null = key()) => {
    const r = http().post(`${API}${path}`).set(bearer(token));
    if (idem) r.set('Idempotency-Key', idem);
    return r.send(body);
  };
  const getOrder = async (id: string, token = tok.waiterA) => (await http().get(`${API}/orders/${id}`).set(bearer(token)).expect(200)).body.data as Order;
  const board = async (branchId = fx.branchA, token = tok.kitchenA) => (await http().get(`${API}/kot`).query({ branchId }).set(bearer(token)).expect(200)).body.data as Ticket[];
  const sales = async (branchId?: string) =>
    (await http().get(`${API}/reports/sales`).query({ ...(branchId ? { branchId } : {}), from: istDate(), to: istDate() }).set(bearer(tok.owner)).expect(200)).body.data;

  async function seatAndOrder(label: string, items: object[], branchId = fx.branchA, waiter = tok.waiterA) {
    const tableId = await addTable(ctx.prisma, fx, branchId, label);
    await http().post(`${API}/branches/${branchId}/tables/${tableId}/open`).set(bearer(waiter)).send({ guestCount: 2 }).expect(201);
    const o = (await post('/orders', { branchId, orderType: 'DINE_IN', tableId, items }, waiter).expect(201)).body.data as Order;
    return { tableId, order: o };
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    fx = await createOrg(ctx.prisma, 'Critical');
    menu = await seedMenu(ctx.prisma, fx);
    for (const h of ['owner', 'managerA', 'cashierA', 'cashierB', 'waiterA', 'kitchenA']) tok[h] = await tokenFor(ctx, fx, h);
    await openShift(ctx, tok.cashierA, fx.branchA);
    await openShift(ctx, tok.cashierB, fx.branchB);
  });
  afterAll(() => ctx.close());

  it('dine-in: waiter orders, kitchen cooks, cashier bills, guest pays by UPI, reports update', async () => {
    const before = (await sales(fx.branchA)).summary;

    // 1. The waiter seats the guests and takes the order.
    const { tableId, order } = await seatAndOrder('C1', [
      { productId: menu.paneer.id, variantId: menu.paneer.full, quantity: '1' },
      { productId: menu.lassi, quantity: '2' },
    ]);
    // Paneer full 320 + 2 × lassi 90 = 500; 5% GST = 25; total 525.
    expect(order.grandTotal).toBe('525');

    // 2. Sending to the kitchen creates tickets on the kitchen screen.
    const confirmed = (await http().post(`${API}/orders/${order.id}/confirm`).set(bearer(tok.waiterA)).send({ version: order.version }).expect(201)).body.data as Order;
    expect(confirmed.status).toBe('CONFIRMED');
    const tickets = (await board()).filter((t) => t.order.id === order.id);
    expect(tickets.length).toBeGreaterThan(0);

    // 3. The kitchen marks every item ready; the order becomes READY, then the waiter serves it.
    for (const t of tickets) for (const i of t.items) await http().patch(`${API}/kot/items/${i.id}/status`).set(bearer(tok.kitchenA)).send({ status: 'READY' }).expect(200);
    expect((await getOrder(order.id)).status).toBe('READY');
    for (const t of tickets) for (const i of t.items) await http().patch(`${API}/kot/items/${i.id}/status`).set(bearer(tok.waiterA)).send({ status: 'SERVED' }).expect(200);
    expect((await getOrder(order.id)).status).toBe('SERVED');

    // 4. The cashier generates the bill; the table waits for payment.
    const inv = (await post('/invoices', { orderId: order.id }, tok.cashierA).expect(201)).body.data;
    expect(inv).toEqual(expect.objectContaining({ status: 'FINALIZED', grandTotal: '525', outstanding: '525', paymentStatus: 'UNPAID' }));
    expect(inv.invoiceNumber).toBeTruthy();
    const table = async () => (await http().get(`${API}/branches/${fx.branchA}/tables/${tableId}`).set(bearer(tok.waiterA)).expect(200)).body.data;
    expect((await table()).status).toBe('BILL_PENDING');

    // 5. The guest pays by UPI; the invoice is settled and the order completes.
    const paid = (await post(`/invoices/${inv.id}/payments`, { method: 'UPI', amount: '525.00', reference: 'UPI-REF-1' }, tok.cashierA).expect(201)).body.data;
    expect([paid.paymentStatus, paid.outstanding, paid.netPaid]).toEqual(['PAID', '0', '525']);
    const pdf = await http().get(`${API}/invoices/${inv.id}/pdf`).set(bearer(tok.cashierA)).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');

    // 6. The sales report and dashboard include the sale straight away.
    const after = (await sales(fx.branchA)).summary;
    expect(after.invoices).toBe(before.invoices + 1);
    expect(Number(after.netSales) - Number(before.netSales)).toBe(500);
    expect(Number(after.collected) - Number(before.collected)).toBe(525);
    const dash = (await http().get(`${API}/dashboard`).query({ branchId: fx.branchA, range: 'today' }).set(bearer(tok.owner)).expect(200)).body.data;
    expect(dash.paymentMethods).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'UPI' })]));
    expect(dash.recentTransactions).toEqual(expect.arrayContaining([expect.objectContaining({ invoiceNumber: inv.invoiceNumber, method: 'UPI', amount: '525.00' })]));

    // 7. Every money-moving step left an audit trail.
    const actions = (await ctx.prisma.auditLog.findMany({ where: { organizationId: fx.orgId }, select: { action: true } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['order.created', 'order.confirmed', 'kot.item.status_changed', 'invoice.issued', 'payment.recorded']));
  });

  it('two devices editing one order: one edit wins, the other is told to refresh', async () => {
    const { order } = await seatAndOrder('C2', [{ productId: menu.lassi, quantity: '1' }]);
    const results = await Promise.all([
      http().patch(`${API}/orders/${order.id}`).set(bearer(tok.waiterA)).send({ version: order.version, addItems: [{ productId: menu.lassi, quantity: '1' }] }),
      http().patch(`${API}/orders/${order.id}`).set(bearer(tok.managerA)).send({ version: order.version, addItems: [{ productId: menu.thali, quantity: '1', modifiers: [{ modifierId: menu.roti }] }] }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('CONCURRENT_UPDATE');
    const o = await getOrder(order.id);
    expect(o.items).toHaveLength(2);
    expect(o.version).toBe(order.version + 1);
  });

  it('a double-tapped payment and a retried checkout charge the guest once', async () => {
    const { order } = await seatAndOrder('C3', [{ productId: menu.lassi, quantity: '1' }]);
    // Checkout retried with the same key (the first response was lost on a bad network).
    const k = key();
    const body = { orderId: order.id, payments: [{ method: 'CASH', amount: '95.00' }] };
    const [a, b] = await Promise.all([post('/billing/checkout', body, tok.cashierA, k), post('/billing/checkout', body, tok.cashierA, k)]);
    const ok = [a, b].filter((r) => r.status === 200);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of [a, b]) if (r.status !== 200) expect(r.body.error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
    const retry = await post('/billing/checkout', body, tok.cashierA, k).expect(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(await ctx.prisma.invoice.count({ where: { orderId: order.id } })).toBe(1);
    expect(await ctx.prisma.payment.count({ where: { allocations: { some: { invoiceId: retry.body.data.id } } } })).toBe(1);

    // A second, different payment attempt on the settled bill is refused.
    const again = await post(`/invoices/${retry.body.data.id}/payments`, { method: 'CASH', amount: '95.00' }, tok.cashierA).expect(422);
    expect(again.body.error.code).toBe('AMOUNT_EXCEEDS_OUTSTANDING');
  });

  it('two cashiers billing the same table at once produce one invoice and one invoice number', async () => {
    const { order } = await seatAndOrder('C4', [{ productId: menu.thali, quantity: '1', modifiers: [{ modifierId: menu.roti }] }]);
    const before = await ctx.prisma.invoice.count({ where: { organizationId: fx.orgId } });
    const results = await Promise.all([post('/invoices', { orderId: order.id }, tok.cashierA), post('/invoices', { orderId: order.id }, tok.managerA)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('ALREADY_INVOICED');
    expect(await ctx.prisma.invoice.count({ where: { organizationId: fx.orgId } })).toBe(before + 1);
  });

  it('both branches trading at once keep separate, gap-free invoice numbers and correct totals', async () => {
    const N = 6;
    const takeaway = (branchId: string, token: string) =>
      post('/orders', { branchId, orderType: 'TAKEAWAY', customerName: 'Rush', items: [{ productId: menu.lassi, quantity: '1' }] }, token)
        .expect(201)
        .then((r) => post('/billing/checkout', { orderId: r.body.data.id, payments: [{ method: 'UPI', amount: '95.00' }] }, token).expect(200))
        .then((r) => r.body.data as { id: string; invoiceNumber: string; branchId: string });
    const beforeA = (await sales(fx.branchA)).summary;
    const beforeB = (await sales(fx.branchB)).summary;
    const invoices = await Promise.all(Array.from({ length: N }, (_, i) => (i % 2 ? takeaway(fx.branchB, tok.cashierB) : takeaway(fx.branchA, tok.cashierA))));

    for (const branchId of [fx.branchA, fx.branchB]) {
      const rows = await ctx.prisma.invoice.findMany({ where: { branchId }, orderBy: { invoiceNumber: 'asc' }, select: { invoiceNumber: true } });
      const seqs = rows.map((r) => Number(/(\d+)$/.exec(r.invoiceNumber)![1])).sort((x, y) => x - y);
      // Gap-free and no duplicates within the branch's series.
      expect(new Set(seqs).size).toBe(seqs.length);
      expect(seqs[seqs.length - 1] - seqs[0] + 1).toBe(seqs.length);
    }
    expect(new Set(invoices.map((i) => i.invoiceNumber)).size).toBe(N);

    const afterA = (await sales(fx.branchA)).summary;
    const afterB = (await sales(fx.branchB)).summary;
    expect(afterA.invoices - beforeA.invoices).toBe(N / 2);
    expect(afterB.invoices - beforeB.invoices).toBe(N / 2);
    expect(Number(afterA.collected) - Number(beforeA.collected)).toBe(95 * (N / 2));
    // The all-branches report is the sum of the two.
    const all = (await sales()).summary;
    expect(Number(all.collected)).toBeCloseTo(Number(afterA.collected) + Number(afterB.collected), 2);
  });
});
