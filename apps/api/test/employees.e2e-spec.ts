import { API, TestContext, createTestApp } from './helpers/app';
import { OrgFixture, bearer, createOrg, tokenFor } from './helpers/fixtures';

interface Employee {
  id: string;
  employeeCode: string;
  fullName: string;
  monthlySalary?: string | null;
  primaryBranchId: string | null;
  userId: string | null;
  user: { id: string; email: string; userRoles: { branchId: string | null; role: { key: string } }[] } | null;
}
interface Attendance {
  id: string;
  employeeId: string;
  status: string;
  workDate: string;
  clockInAt: string | null;
  clockOutAt: string | null;
  hoursWorked: string;
}

const istDate = (daysAgo = 0) => new Date(Date.now() + 5.5 * 3600_000 - daysAgo * 86_400_000).toISOString().slice(0, 10);

describe('Employees and attendance (e2e)', () => {
  let ctx: TestContext;
  let fx: OrgFixture;
  let other: OrgFixture;
  const tok: Record<string, string> = {};
  const emp: Record<string, Employee> = {};

  const http = () => ctx.http();
  const post = (path: string, body: object, token: string) => http().post(`${API}${path}`).set(bearer(token)).send(body);

  beforeAll(async () => {
    ctx = await createTestApp();
    fx = await createOrg(ctx.prisma, 'Staff');
    other = await createOrg(ctx.prisma, 'StaffOther');
    for (const h of ['owner', 'managerA', 'managerB', 'cashierA', 'waiterA', 'kitchenA', 'inventoryA', 'accountant']) tok[h] = await tokenFor(ctx, fx, h);
    tok.otherOwner = await tokenFor(ctx, other, 'owner');
  });
  afterAll(() => ctx.close());

  describe('profiles', () => {
    it('a branch manager creates profiles for their branch and links login accounts', async () => {
      const res = await post('/employees', { employeeCode: 'w-001', fullName: 'Asha Waiter', designation: 'Captain', joiningDate: '2026-04-01', monthlySalary: '18000', primaryBranchId: fx.branchA, userId: fx.users.waiterA.id }, tok.managerA).expect(201);
      emp.waiter = res.body.data;
      expect(emp.waiter).toEqual(expect.objectContaining({ employeeCode: 'W-001', monthlySalary: '18000', userId: fx.users.waiterA.id }));
      expect(emp.waiter.user?.userRoles.map((r) => r.role.key)).toEqual(['WAITER']);

      for (const [k, code, user] of [['kitchen', 'K-001', 'kitchenA'], ['inventory', 'I-001', 'inventoryA']] as const) {
        emp[k] = (await post('/employees', { employeeCode: code, fullName: `${k} person`, primaryBranchId: fx.branchA, userId: fx.users[user].id }, tok.managerA).expect(201)).body.data;
      }
      const dup = await post('/employees', { employeeCode: 'W-001', fullName: 'Someone', primaryBranchId: fx.branchA }, tok.managerA).expect(409);
      expect(dup.body.error.code).toBe('DUPLICATE_EMPLOYEE_CODE');
      const linked = await post('/employees', { employeeCode: 'W-002', fullName: 'Copy', primaryBranchId: fx.branchA, userId: fx.users.waiterA.id }, tok.managerA).expect(409);
      expect(linked.body.error.code).toBe('USER_ALREADY_LINKED');

      await post('/employees', { employeeCode: 'X-1', fullName: 'Not mine', primaryBranchId: fx.branchA }, tok.managerB).expect(404);
      await post('/employees', { employeeCode: 'X-2', fullName: 'No branch' }, tok.managerA).expect(403);
      await post('/employees', { employeeCode: 'X-3', fullName: 'Head office' }, tok.owner).expect(201);
      await post('/employees', { employeeCode: 'X-4', fullName: 'Nope', primaryBranchId: fx.branchA }, tok.waiterA).expect(403);
    });

    it('each manager sees their own branch’s staff; owners see everyone', async () => {
      const a = await http().get(`${API}/employees`).set(bearer(tok.managerA)).expect(200);
      expect(a.body.data.map((e: Employee) => e.employeeCode).sort()).toEqual(['I-001', 'K-001', 'W-001']);
      const b = await http().get(`${API}/employees`).set(bearer(tok.managerB)).expect(200);
      expect(b.body.data).toEqual([]);
      await http().get(`${API}/employees/${emp.waiter.id}`).set(bearer(tok.managerB)).expect(404);
      const all = await http().get(`${API}/employees`).set(bearer(tok.owner)).expect(200);
      expect(all.body.data).toHaveLength(4);
      await http().get(`${API}/employees/${emp.waiter.id}`).set(bearer(tok.otherOwner)).expect(404);
      const me = await http().get(`${API}/employees/me`).set(bearer(tok.waiterA)).expect(200);
      expect(me.body.data.id).toBe(emp.waiter.id);
    });

    it('edits are audited', async () => {
      await http().patch(`${API}/employees/${emp.waiter.id}`).set(bearer(tok.managerA)).send({ monthlySalary: '19500', designation: 'Senior captain' }).expect(200);
      const log = await ctx.prisma.auditLog.findFirstOrThrow({ where: { entityId: emp.waiter.id, action: 'employee.updated' } });
      expect(log.before).toEqual(expect.objectContaining({ monthlySalary: '18000', designation: 'Captain' }));
      expect(log.after).toEqual(expect.objectContaining({ monthlySalary: '19500', designation: 'Senior captain' }));
    });
  });

  describe('attendance', () => {
    it('staff clock in and out for themselves, once a day', async () => {
      const noProfile = await post('/attendance/clock-in', { branchId: fx.branchA }, tok.cashierA).expect(422);
      expect(noProfile.body.error.code).toBe('EMPLOYEE_PROFILE_REQUIRED');
      await post('/attendance/clock-in', { branchId: fx.branchB }, tok.waiterA).expect(403);

      const inRes = await post('/attendance/clock-in', { branchId: fx.branchA }, tok.waiterA).expect(201);
      const a = inRes.body.data as Attendance;
      expect(a).toEqual(expect.objectContaining({ status: 'PRESENT', workDate: `${istDate()}T00:00:00.000Z`, clockInAt: expect.any(String), clockOutAt: null, hoursWorked: '0' }));
      expect((await post('/attendance/clock-in', { branchId: fx.branchA }, tok.waiterA).expect(409)).body.error.code).toBe('ALREADY_CLOCKED_IN');

      const del = await http().delete(`${API}/employees/${emp.waiter.id}`).set(bearer(tok.managerA)).expect(409);
      expect(del.body.error.code).toBe('EMPLOYEE_CLOCKED_IN');

      const out = await post('/attendance/clock-out', {}, tok.waiterA).expect(200);
      expect(out.body.data.clockOutAt).toEqual(expect.any(String));
      expect((await post('/attendance/clock-out', {}, tok.waiterA).expect(409)).body.error.code).toBe('NOT_CLOCKED_IN');
      expect((await post('/attendance/clock-in', { branchId: fx.branchA }, tok.waiterA).expect(409)).body.error.code).toBe('ALREADY_CLOCKED_OUT');
    });

    it('simultaneous clock-ins record one attendance', async () => {
      const res = await Promise.all(Array.from({ length: 4 }, () => post('/attendance/clock-in', { branchId: fx.branchA }, tok.kitchenA)));
      expect(res.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
      expect(await ctx.prisma.attendance.count({ where: { employeeId: emp.kitchen.id } })).toBe(1);
    });

    it('a forgotten clock-in is not closed hours later; a manager records the right times', async () => {
      const day = istDate(2);
      await ctx.prisma.attendance.create({
        data: { organizationId: fx.orgId, branchId: fx.branchA, employeeId: emp.inventory.id, workDate: new Date(`${day}T00:00:00Z`), clockInAt: new Date(`${day}T09:00:00+05:30`) },
      });
      expect((await post('/attendance/clock-out', {}, tok.inventoryA).expect(409)).body.error.code).toBe('CLOCK_IN_TOO_OLD');

      const put = (body: object, token = tok.managerA) => http().put(`${API}/attendance`).set(bearer(token)).send({ branchId: fx.branchA, employeeId: emp.inventory.id, workDate: day, reason: 'Forgot to clock out', ...body });
      await put({ status: 'PRESENT', clockInAt: `${day}T09:00:00+05:30`, clockOutAt: `${day}T17:30:00+05:30` }, tok.waiterA).expect(403);
      expect((await put({ status: 'ABSENT', clockInAt: `${day}T09:00:00+05:30` }).expect(400)).body.error.code).toBe('TIMES_NOT_ALLOWED');
      expect((await put({ status: 'PRESENT', clockInAt: `${day}T18:00:00+05:30`, clockOutAt: `${day}T09:00:00+05:30` }).expect(400)).body.error.code).toBe('INVALID_TIMES');
      const fixed = (await put({ status: 'PRESENT', clockInAt: `${day}T09:00:00+05:30`, clockOutAt: `${day}T17:30:00+05:30` }).expect(200)).body.data as Attendance;
      expect(fixed.hoursWorked).toBe('8.5');
      const log = await ctx.prisma.auditLog.findFirstOrThrow({ where: { entityId: fixed.id, action: 'attendance.corrected' } });
      expect(log.before).toEqual(expect.objectContaining({ clockOutAt: null }));
      expect(log.after).toEqual(expect.objectContaining({ reason: 'Forgot to clock out' }));

      await put({ workDate: istDate(1), status: 'LEAVE', reason: 'Approved leave' }).expect(200);
      await put({ workDate: istDate(3), status: 'HALF_DAY', clockInAt: `${istDate(3)}T09:00:00+05:30`, clockOutAt: `${istDate(3)}T13:00:00+05:30`, reason: 'Half day' }).expect(200);
      expect((await put({ workDate: istDate(-1), status: 'ABSENT' }).expect(400)).body.error.code).toBe('FUTURE_DATE');
    });

    it('reports attendance and hours per employee', async () => {
      const q = { branchId: fx.branchA, from: istDate(7), to: istDate() };
      const sum = (await http().get(`${API}/attendance/summary`).query(q).set(bearer(tok.managerA)).expect(200)).body.data;
      const inv = sum.find((s: { employee: { id: string } }) => s.employee.id === emp.inventory.id);
      expect(inv).toEqual(expect.objectContaining({ present: 1, halfDays: 1, leave: 1, absent: 0, hours: '12.5', stillClockedIn: 0 }));
      const kitchen = sum.find((s: { employee: { id: string } }) => s.employee.id === emp.kitchen.id);
      expect(kitchen).toEqual(expect.objectContaining({ present: 1, stillClockedIn: 1 }));
      await http().get(`${API}/attendance`).query(q).set(bearer(tok.managerB)).expect(403);
      const mine = (await http().get(`${API}/attendance/me`).query({ from: istDate(7), to: istDate() }).set(bearer(tok.waiterA)).expect(200)).body.data as Attendance[];
      expect(mine).toHaveLength(1);
      expect((await http().get(`${API}/attendance/me`).query({ from: '2024-01-01', to: istDate() }).set(bearer(tok.waiterA)).expect(400)).body.error.code).toBe('RANGE_TOO_LONG');
    });

    it('shows an employee’s logins and recent actions', async () => {
      const act = (await http().get(`${API}/employees/${emp.waiter.id}/activity`).set(bearer(tok.managerA)).expect(200)).body.data;
      expect(act.sessions.length).toBeGreaterThanOrEqual(1);
      expect(act.sessions[0]).toEqual(expect.objectContaining({ loggedInAt: expect.any(String), active: true }));
      expect(act.actions.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(['attendance.clock_in', 'attendance.clock_out']));
    });
  });
});
