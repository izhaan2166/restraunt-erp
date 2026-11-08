import { API, TestContext, createTestApp } from './helpers/app';
import { OrgFixture, bearer, createOrg, tokenFor } from './helpers/fixtures';
import { MenuFixture, key, seedMenu } from './helpers/menu';

interface Shift {
  id: string;
  status: string;
  openingBalance: string;
  expectedCash: string;
  actualCash: string | null;
  discrepancy: string | null;
}
interface Report {
  status: string;
  cashier: { id: string };
  closedBy: { id: string } | null;
  cash: { openingFloat: string; cashSales: string; cashRefunds: string; cashIn: string; cashOut: string; expenses: string; expected: string; actual: string | null; discrepancy: string | null; notes: string | null };
  counts: { cashSales: number; cashRefunds: number; cashIn: number; cashOut: number };
  paymentsByMethod: { method: string; count: number; amount: string }[];
  totalCollected: string;
}

describe('Cash shifts: drawer, cash sales and refunds, reconciliation (e2e)', () => {
  let ctx: TestContext;
  let fx: OrgFixture;
  let other: OrgFixture;
  let menu: MenuFixture;
  const tok: Record<string, string> = {};
  let shift: Shift;

  const http = () => ctx.http();
  const post = (path: string, body: object, token = tok.cashierA, idem: string | null = key()) => {
    const r = http().post(`${API}${path}`).set(bearer(token));
    if (idem) r.set('Idempotency-Key', idem);
    return r.send(body);
  };
  const report = async (id: string, token = tok.cashierA) => (await http().get(`${API}/cash-sessions/${id}/report`).set(bearer(token)).expect(200)).body.data as Report;
  const expected = async (id: string) => (await http().get(`${API}/cash-sessions/${id}`).set(bearer(tok.managerA)).expect(200)).body.data.expectedCash as string;

  /** A takeaway for `qty` lassis with its invoice issued (nothing paid). */
  async function bill(qty = '2', token = tok.cashierA) {
    const o = (await post('/orders', { branchId: fx.branchA, orderType: 'TAKEAWAY', items: [{ productId: menu.lassi, quantity: qty }] }, token).expect(201)).body.data;
    return (await post('/billing/checkout', { orderId: o.id, payments: [] }, token).expect(200)).body.data as { id: string; outstanding: string };
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    fx = await createOrg(ctx.prisma, 'Cash');
    other = await createOrg(ctx.prisma, 'CashOther');
    menu = await seedMenu(ctx.prisma, fx);
    for (const h of ['owner', 'managerA', 'managerB', 'cashierA', 'cashierB', 'waiterA', 'accountant']) tok[h] = await tokenFor(ctx, fx, h);
    tok.otherOwner = await tokenFor(ctx, other, 'owner');
  });
  afterAll(() => ctx.close());

  it('cash cannot be taken without an open shift; other payment methods can', async () => {
    const inv = await bill('1');
    const res = await post(`/invoices/${inv.id}/payments`, { method: 'CASH', amount: inv.outstanding }).expect(409);
    expect(res.body.error.code).toBe('NO_OPEN_SHIFT');
    await post(`/invoices/${inv.id}/payments`, { method: 'UPI', amount: inv.outstanding }).expect(201);
  });

  it('a cashier opens one shift with a counted float', async () => {
    await post('/cash-sessions/open', { branchId: fx.branchA, openingBalance: '2000' }, tok.waiterA).expect(403);
    const res = await post('/cash-sessions/open', { branchId: fx.branchA, openingBalance: '2000.00', terminal: 'Counter 1' }).expect(201);
    shift = res.body.data;
    expect(shift).toEqual(expect.objectContaining({ status: 'OPEN', openingBalance: '2000', expectedCash: '2000', terminal: 'Counter 1' }));
    const again = await post('/cash-sessions/open', { branchId: fx.branchA, openingBalance: '0' }).expect(409);
    expect(again.body.error.code).toBe('SHIFT_ALREADY_OPEN');
    const current = await http().get(`${API}/cash-sessions/current`).query({ branchId: fx.branchA }).set(bearer(tok.cashierA)).expect(200);
    expect(current.body.data.id).toBe(shift.id);
    const ev = await ctx.prisma.realtimeEvent.findMany({ where: { entityId: shift.id } });
    expect(ev.map((e) => e.type)).toEqual(['shift.opened']);
  });

  it('cash payments land in the drawer of the cashier who took them', async () => {
    const inv = await bill('2');
    expect(inv.outstanding).toBe('189');
    const paid = await post(`/invoices/${inv.id}/payments`, { method: 'CASH', amount: '189.00' }).expect(201);
    const p = paid.body.data.payments[0];
    const row = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.cashSessionId).toBe(shift.id);
    const mv = await ctx.prisma.cashMovement.findMany({ where: { cashSessionId: shift.id, type: 'CASH_SALE' } });
    expect(mv.map((m) => [m.amount.toString(), m.referenceType, m.referenceId])).toEqual([['189', 'payment', p.id]]);
    expect(await expected(shift.id)).toBe('2189');
  });

  it('adds change and takes cash out with reasons; the drawer never goes below zero', async () => {
    const adds = await Promise.all(Array.from({ length: 5 }, (_, n) => post(`/cash-sessions/${shift.id}/movements`, { type: 'CASH_IN', amount: '100', reason: `Change ${n}` })));
    expect(adds.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(await expected(shift.id)).toBe('2689');

    const over = await post(`/cash-sessions/${shift.id}/movements`, { type: 'CASH_OUT', amount: '3000', reason: 'Bank deposit' }).expect(409);
    expect(over.body.error.code).toBe('INSUFFICIENT_CASH');
    await post(`/cash-sessions/${shift.id}/movements`, { type: 'CASH_OUT', amount: '500', reason: 'Bank deposit' }).expect(201);
    expect(await expected(shift.id)).toBe('2189');
    // Someone else's drawer needs supervisor rights.
    await post(`/cash-sessions/${shift.id}/movements`, { type: 'CASH_IN', amount: '1', reason: 'Not mine' }, tok.cashierB).expect(404);
  });

  it('a cash refund approved by a manager is paid out of the requesting cashier’s drawer', async () => {
    const inv = await bill('2');
    const paid = (await post(`/invoices/${inv.id}/payments`, { method: 'CASH', amount: inv.outstanding }).expect(201)).body.data;
    const lassi = paid.items[0];
    const cn = (await http().post(`${API}/invoices/${inv.id}/credit-notes`).set(bearer(tok.managerA)).send({ reason: 'Spilt', lines: [{ invoiceItemId: lassi.id, quantity: '1' }] }).expect(201)).body.data;
    const r = (await post(`/invoices/${inv.id}/refunds`, { paymentId: paid.payments[0].id, amount: '94.50', reason: 'Spilt', creditNoteId: cn.creditNotes[0].id }).expect(201)).body.data;
    expect(r.status).toBe('PENDING');
    expect(await expected(shift.id)).toBe('2378'); // 2189 + 189, nothing paid out yet
    await http().post(`${API}/refunds/${r.id}/approve`).set(bearer(tok.managerA)).expect(200);
    const refund = await ctx.prisma.refund.findUniqueOrThrow({ where: { id: r.id } });
    expect(refund.cashSessionId).toBe(shift.id);
    expect(await expected(shift.id)).toBe('2283.5');
  });

  it('the shift report shows the drawer and every payment method the cashier took', async () => {
    const rep = await report(shift.id);
    expect(rep.cash).toEqual(expect.objectContaining({ openingFloat: '2000', cashSales: '378', cashRefunds: '94.5', cashIn: '500', cashOut: '500', expenses: '0', expected: '2283.5', actual: null }));
    expect(rep.counts).toEqual(expect.objectContaining({ cashSales: 2, cashRefunds: 1, cashIn: 5, cashOut: 1 }));
    expect(rep.paymentsByMethod).toEqual([expect.objectContaining({ method: 'CASH', count: 2, amount: '378' })]);
    // Visible to the cashier, to people with shift rights, not to other branches.
    await report(shift.id, tok.accountant);
    await http().get(`${API}/cash-sessions/${shift.id}/report`).set(bearer(tok.cashierB)).expect(404);
    await http().get(`${API}/cash-sessions/${shift.id}`).set(bearer(tok.otherOwner)).expect(404);
  });

  it('closing compares the count with the expected cash and explains any difference', async () => {
    const noNote = await http().post(`${API}/cash-sessions/${shift.id}/close`).set(bearer(tok.cashierA)).send({ actualCash: '2273.50' }).expect(400);
    expect(noNote.body.error.code).toBe('DISCREPANCY_NOTE_REQUIRED');
    expect(noNote.body.error.details).toEqual({ expectedCash: '2283.50', discrepancy: '-10.00' });

    const res = await http().post(`${API}/cash-sessions/${shift.id}/close`).set(bearer(tok.cashierA)).send({ actualCash: '2273.50', notes: 'Gave wrong change once' }).expect(200);
    const rep = res.body.data as Report;
    expect(rep.status).toBe('CLOSED');
    expect(rep.cash).toEqual(expect.objectContaining({ expected: '2283.5', actual: '2273.5', discrepancy: '-10', notes: 'Gave wrong change once' }));
    expect(rep.closedBy?.id).toBe(fx.users.cashierA.id);

    const ev = await ctx.prisma.realtimeEvent.findMany({ where: { entityId: shift.id }, orderBy: { pendingId: 'asc' } });
    expect(ev.map((e) => e.type)).toEqual(['shift.opened', 'shift.closed']);
    expect(ev[1].payload).toEqual(expect.objectContaining({ discrepancy: '-10', expectedCash: '2283.5', actualCash: '2273.5' }));
    const note = await ctx.prisma.notification.findFirstOrThrow({ where: { branchId: fx.branchA, type: 'shift.discrepancy' } });
    expect(note.title).toMatch(/^Cash short: /);
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { entityId: shift.id, action: 'shift.closed' } });
    expect(audit.after).toEqual(expect.objectContaining({ discrepancy: '-10' }));
  });

  it('a closed shift is final', async () => {
    const twice = await http().post(`${API}/cash-sessions/${shift.id}/close`).set(bearer(tok.cashierA)).send({ actualCash: '1' }).expect(409);
    expect(twice.body.error.code).toBe('SHIFT_CLOSED');
    await post(`/cash-sessions/${shift.id}/movements`, { type: 'CASH_IN', amount: '1', reason: 'Late' }).expect(409);
    await expect(ctx.prisma.cashSession.update({ where: { id: shift.id }, data: { actualCash: '2283.5' } })).rejects.toThrow();
    await expect(ctx.prisma.cashMovement.create({ data: { organizationId: fx.orgId, branchId: fx.branchA, cashSessionId: shift.id, type: 'CASH_IN', amount: '1', createdById: fx.users.cashierA.id } })).rejects.toThrow();
    const inv = await bill('1');
    const res = await post(`/invoices/${inv.id}/payments`, { method: 'CASH', amount: inv.outstanding }).expect(409);
    expect(res.body.error.code).toBe('NO_OPEN_SHIFT');
  });

  it('a manager can close a cashier’s shift; the summary adds up shifts per cashier', async () => {
    const s2 = (await post('/cash-sessions/open', { branchId: fx.branchA, openingBalance: '500' }).expect(201)).body.data as Shift;
    await http().post(`${API}/cash-sessions/${s2.id}/close`).set(bearer(tok.waiterA)).send({ actualCash: '500' }).expect(403);
    const closed = (await http().post(`${API}/cash-sessions/${s2.id}/close`).set(bearer(tok.managerA)).send({ actualCash: '500' }).expect(200)).body.data as Report;
    expect(closed.cash.discrepancy).toBe('0');
    expect(closed.closedBy?.id).toBe(fx.users.managerA.id);

    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    const list = await http().get(`${API}/cash-sessions`).query({ branchId: fx.branchA, status: 'CLOSED' }).set(bearer(tok.accountant)).expect(200);
    expect(list.body.data.map((s: Shift) => s.id).sort()).toEqual([shift.id, s2.id].sort());
    await http().get(`${API}/cash-sessions`).query({ branchId: fx.branchA }).set(bearer(tok.cashierA)).expect(403);
    const sum = await http().get(`${API}/cash-sessions/summary`).query({ branchId: fx.branchA, from: today, to: today }).set(bearer(tok.managerA)).expect(200);
    expect(sum.body.data).toEqual([
      expect.objectContaining({ cashier: expect.objectContaining({ id: fx.users.cashierA.id }), shifts: 2, openShifts: 0, cashSales: '378', cashRefunds: '94.5', shortages: '10', overages: '0', netDiscrepancy: '-10' }),
    ]);
  });

  it('a branch can allow cash without a shift', async () => {
    await http().patch(`${API}/branches/${fx.branchA}/settings`).set(bearer(tok.owner)).send({ cashRequiresShift: false }).expect(200);
    try {
      const inv = await bill('1');
      const paid = (await post(`/invoices/${inv.id}/payments`, { method: 'CASH', amount: inv.outstanding }).expect(201)).body.data;
      expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id: paid.payments[0].id } })).cashSessionId).toBeNull();
    } finally {
      await http().patch(`${API}/branches/${fx.branchA}/settings`).set(bearer(tok.owner)).send({ cashRequiresShift: true }).expect(200);
    }
  });
});
