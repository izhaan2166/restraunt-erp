import { API, TestContext, binary, createTestApp } from './helpers/app';
import { OrgFixture, bearer, createOrg, openShift, tokenFor } from './helpers/fixtures';
import { key } from './helpers/menu';

interface Expense {
  id: string;
  amount: string;
  taxAmount: string;
  description: string;
  expenseDate: string;
  paymentMethod: string;
  cashSessionId: string | null;
  receiptUrl: string | null;
  deletedAt: string | null;
  deleteReason: string | null;
  category: { id: string; name: string };
  employee: { id: string } | null;
}

const istDate = (daysAgo = 0) => new Date(Date.now() + 5.5 * 3600_000 - daysAgo * 86_400_000).toISOString().slice(0, 10);
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

describe('Expenses (e2e)', () => {
  let ctx: TestContext;
  let fx: OrgFixture;
  let other: OrgFixture;
  const tok: Record<string, string> = {};
  const cat: Record<string, string> = {};
  let employeeId: string;
  let drawerId: string;
  let cashExpense: Expense;

  const http = () => ctx.http();
  const post = (path: string, body: object, token = tok.managerA, idem: string | null = key()) => {
    const r = http().post(`${API}${path}`).set(bearer(token));
    if (idem) r.set('Idempotency-Key', idem);
    return r.send(body);
  };
  const base = () => ({ branchId: fx.branchA, categoryId: cat.Electricity, amount: '4720.00', taxAmount: '720.00', description: 'Electricity bill October', expenseDate: istDate(2), paymentMethod: 'UPI' });
  const drawer = async () => (await http().get(`${API}/cash-sessions/${drawerId}`).set(bearer(tok.managerA)).expect(200)).body.data.expectedCash as string;

  beforeAll(async () => {
    ctx = await createTestApp();
    fx = await createOrg(ctx.prisma, 'Expense');
    other = await createOrg(ctx.prisma, 'ExpenseOther');
    for (const h of ['owner', 'managerA', 'managerB', 'cashierA', 'accountant']) tok[h] = await tokenFor(ctx, fx, h);
    tok.otherOwner = await tokenFor(ctx, other, 'owner');
    employeeId = (await ctx.prisma.employee.create({ data: { organizationId: fx.orgId, employeeCode: 'E-1', fullName: 'Ravi', primaryBranchId: fx.branchA } })).id;
  });
  afterAll(() => ctx.close());

  it('manages expense categories', async () => {
    await post('/expense-categories', { name: 'Rent' }, tok.cashierA, null).expect(403);
    for (const name of ['Electricity', 'Staff food', 'Repairs']) cat[name] = (await post('/expense-categories', { name }, tok.managerA, null).expect(201)).body.data.id;
    const dup = await post('/expense-categories', { name: 'electricity' }, tok.managerA, null).expect(409);
    expect(dup.body.error.code).toBe('DUPLICATE_NAME');
    await http().patch(`${API}/expense-categories/${cat.Repairs}`).set(bearer(tok.managerA)).send({ isActive: false }).expect(403);
    await http().patch(`${API}/expense-categories/${cat.Repairs}`).set(bearer(tok.accountant)).send({ isActive: false }).expect(200);
    const list = await http().get(`${API}/expense-categories`).set(bearer(tok.managerA)).expect(200);
    expect(list.body.data.map((c: { name: string }) => c.name)).toEqual(['Electricity', 'Staff food']);
  });

  it('records an expense with its GST and checks amounts and dates', async () => {
    const res = await post('/expenses', { ...base(), paidTo: 'BESCOM', employeeId }).expect(201);
    expect(res.body.data).toEqual(expect.objectContaining({ amount: '4720', taxAmount: '720', paymentMethod: 'UPI', cashSessionId: null, category: expect.objectContaining({ name: 'Electricity' }), employee: expect.objectContaining({ id: employeeId }) }));
    expect(res.body.data.expenseDate).toBe(`${istDate(2)}T00:00:00.000Z`);

    expect((await post('/expenses', { ...base(), taxAmount: '5000' }).expect(400)).body.error.code).toBe('INVALID_TAX');
    expect((await post('/expenses', { ...base(), expenseDate: istDate(-2) }).expect(400)).body.error.code).toBe('FUTURE_DATE');
    expect((await post('/expenses', { ...base(), categoryId: cat.Repairs }).expect(422)).body.error.code).toBe('CATEGORY_INACTIVE');
    await post('/expenses', base(), tok.cashierA).expect(403);
    await post('/expenses', { ...base(), branchId: fx.branchB }).expect(403);
  });

  it('cash paid out of the drawer comes off the expected cash', async () => {
    const body = { ...base(), categoryId: cat['Staff food'], amount: '300', taxAmount: '0', description: 'Lunch for staff', expenseDate: istDate(), paymentMethod: 'CASH', fromCashDrawer: true };
    expect((await post('/expenses', body).expect(409)).body.error.code).toBe('NO_OPEN_SHIFT');
    expect((await post('/expenses', { ...body, paymentMethod: 'UPI' }).expect(400)).body.error.code).toBe('DRAWER_NEEDS_CASH');
    drawerId = await openShift(ctx, tok.managerA, fx.branchA, '1000');
    expect((await post('/expenses', { ...body, amount: '1000.01' }).expect(409)).body.error.code).toBe('INSUFFICIENT_CASH');

    cashExpense = (await post('/expenses', body).expect(201)).body.data;
    expect(cashExpense.cashSessionId).toBe(drawerId);
    expect(await drawer()).toBe('700');
    const rep = (await http().get(`${API}/cash-sessions/${drawerId}/report`).set(bearer(tok.managerA)).expect(200)).body.data;
    expect(rep.cash.expenses).toBe('300');
  });

  it('only authorised people edit or delete; every change is kept with its reason', async () => {
    await http().patch(`${API}/expenses/${cashExpense.id}`).set(bearer(tok.managerA)).send({ amount: '250', reason: 'Bill corrected' }).expect(403);
    const noReason = await http().patch(`${API}/expenses/${cashExpense.id}`).set(bearer(tok.accountant)).send({ amount: '250' }).expect(400);
    expect(noReason.body.error.code).toBe('VALIDATION_FAILED');
    const edited = await http().patch(`${API}/expenses/${cashExpense.id}`).set(bearer(tok.accountant)).send({ amount: '250', reason: 'Bill corrected' }).expect(200);
    expect(edited.body.data.amount).toBe('250');
    expect(await drawer()).toBe('750'); // the ₹50 difference went back into the drawer
    const method = await http().patch(`${API}/expenses/${cashExpense.id}`).set(bearer(tok.accountant)).send({ paymentMethod: 'UPI', reason: 'Paid by UPI really' }).expect(409);
    expect(method.body.error.code).toBe('EXPENSE_FROM_DRAWER');

    await http().delete(`${API}/expenses/${cashExpense.id}`).set(bearer(tok.accountant)).send({ reason: 'Entered twice' }).expect(403);
    await http().delete(`${API}/expenses/${cashExpense.id}`).set(bearer(tok.owner)).send({ reason: 'Entered twice' }).expect(204);
    expect(await drawer()).toBe('1000');
    const gone = await http().patch(`${API}/expenses/${cashExpense.id}`).set(bearer(tok.accountant)).send({ description: 'x y z', reason: 'Late edit' }).expect(409);
    expect(gone.body.error.code).toBe('EXPENSE_DELETED');

    const list = await http().get(`${API}/expenses`).query({ branchId: fx.branchA }).set(bearer(tok.managerA)).expect(200);
    expect(list.body.data.map((e: Expense) => e.id)).not.toContain(cashExpense.id);
    const all = await http().get(`${API}/expenses`).query({ branchId: fx.branchA, includeDeleted: 'true' }).set(bearer(tok.managerA)).expect(200);
    expect(all.body.data.find((e: Expense) => e.id === cashExpense.id)).toEqual(expect.objectContaining({ deleteReason: 'Entered twice', deletedAt: expect.any(String) }));

    const hist = (await http().get(`${API}/expenses/${cashExpense.id}/history`).set(bearer(tok.managerA)).expect(200)).body.data;
    expect(hist.map((h: { action: string }) => h.action)).toEqual(['expense.created', 'expense.updated', 'expense.deleted']);
    expect(hist[1]).toEqual(expect.objectContaining({ before: expect.objectContaining({ amount: '300' }), after: expect.objectContaining({ amount: '250', reason: 'Bill corrected' }), by: expect.objectContaining({ id: fx.users.accountant.id }) }));
  });

  it('a drawer expense cannot change amount once its shift is closed', async () => {
    const e = (await post('/expenses', { ...base(), amount: '100', taxAmount: '0', expenseDate: istDate(), paymentMethod: 'CASH', fromCashDrawer: true }).expect(201)).body.data as Expense;
    await http().post(`${API}/cash-sessions/${drawerId}/close`).set(bearer(tok.managerA)).send({ actualCash: '900' }).expect(200);
    const res = await http().patch(`${API}/expenses/${e.id}`).set(bearer(tok.accountant)).send({ amount: '120', reason: 'More' }).expect(409);
    expect(res.body.error.code).toBe('SHIFT_CLOSED');
    await http().patch(`${API}/expenses/${e.id}`).set(bearer(tok.accountant)).send({ description: 'Gas cylinder refill', reason: 'Clearer text' }).expect(200);
    expect((await http().delete(`${API}/expenses/${e.id}`).set(bearer(tok.owner)).send({ reason: 'Wrong' }).expect(409)).body.error.code).toBe('SHIFT_CLOSED');
  });

  it('stores receipts only when they really are images or PDFs', async () => {
    const e = (await post('/expenses', base()).expect(201)).body.data as Expense;
    const bad = await http().post(`${API}/expenses/${e.id}/receipt`).set(bearer(tok.managerA)).attach('receipt', Buffer.from('<html>hi</html>'), 'receipt.png').expect(422);
    expect(bad.body.error.code).toBe('UNSUPPORTED_FILE');
    const png = await http().post(`${API}/expenses/${e.id}/receipt`).set(bearer(tok.managerA)).attach('receipt', PNG, 'bill.png').expect(201);
    expect(png.body.data.receiptUrl).toBe(`/api/v1/expenses/${e.id}/receipt`);
    expect(png.body.data).not.toHaveProperty('receiptKey');
    const got = await http().get(`${API}/expenses/${e.id}/receipt`).set(bearer(tok.managerA)).buffer(true).parse(binary).expect(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['cache-control']).toBe('private, no-store');
    expect(Buffer.compare(got.body as Buffer, PNG)).toBe(0);
    await http().get(`${API}/expenses/${e.id}/receipt`).expect(401);
    await http().get(`${API}/expenses/${e.id}/receipt`).set(bearer(tok.managerB)).expect(404);
    // Nothing under the public uploads path ever serves a receipt.
    const row = await ctx.prisma.expense.findUniqueOrThrow({ where: { id: e.id } });
    expect(row.receiptKey).toMatch(new RegExp(`^${fx.orgId}/receipts/[0-9a-f-]{36}\\.png$`));
    await http().get(`/uploads/${row.receiptKey}`).expect(404);
    await http().post(`${API}/expenses/${e.id}/receipt`).set(bearer(tok.accountant)).attach('receipt', PDF, 'bill.pdf').expect(201);
    const gotPdf = await http().get(`${API}/expenses/${e.id}/receipt`).set(bearer(tok.accountant)).buffer(true).parse(binary).expect(200);
    expect(gotPdf.headers['content-type']).toBe('application/pdf');
    await http().post(`${API}/expenses/${e.id}/receipt`).set(bearer(tok.managerB)).attach('receipt', PNG, 'bill.png').expect(404);
  });

  it('summarises a period by category and payment method', async () => {
    const res = await http().get(`${API}/expenses/summary`).query({ branchId: fx.branchA, from: istDate(30), to: istDate() }).set(bearer(tok.accountant)).expect(200);
    const s = res.body.data;
    // Two ₹4,720 electricity bills (UPI) and the ₹100 cash refill (also under Electricity); the deleted staff lunch is left out.
    expect([s.count, s.total, s.taxTotal]).toEqual([3, '9540', '1440']);
    expect(s.byCategory).toEqual([expect.objectContaining({ name: 'Electricity', count: 3, amount: '9540', taxAmount: '1440' })]);
    expect(s.byPaymentMethod).toEqual([expect.objectContaining({ method: 'CASH', amount: '100' }), expect.objectContaining({ method: 'UPI', amount: '9440' })]);
  });

  it('other branches and organizations cannot see these expenses', async () => {
    await http().get(`${API}/expenses`).query({ branchId: fx.branchA }).set(bearer(tok.managerB)).expect(403);
    const any = (await http().get(`${API}/expenses`).query({ branchId: fx.branchA }).set(bearer(tok.managerA)).expect(200)).body.data[0] as Expense;
    await http().get(`${API}/expenses/${any.id}`).set(bearer(tok.managerB)).expect(404);
    await http().get(`${API}/expenses/${any.id}`).set(bearer(tok.otherOwner)).expect(404);
    const res = await post('/expenses', { ...base(), categoryId: cat.Electricity }, tok.otherOwner);
    expect([400, 403, 404]).toContain(res.status);
  });
});
