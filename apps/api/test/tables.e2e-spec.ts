import { API, TestContext, createTestApp } from './helpers/app';
import { OrgFixture, bearer, createOrg, tokenFor } from './helpers/fixtures';

interface TableView {
  id: string;
  label: string;
  status: string;
  version: number;
  posX: number;
  reservationName: string | null;
  session: { id: string; guestCount: number; mergedIntoTableId: string | null; mergedTableIds: string[] } | null;
}

describe('Tables & floor plan (e2e)', () => {
  let ctx: TestContext;
  let fx: OrgFixture;
  let other: OrgFixture;
  const tok: Record<string, string> = {};
  const t: Record<string, string> = {};
  let base: string;

  const view = async (id: string) => (await ctx.http().get(`${base}/${id}`).set(bearer(tok.waiterA)).expect(200)).body.data as TableView;
  const op = (id: string, action: string, body: object = {}, token = tok.waiterA) =>
    ctx.http().post(`${base}/${id}/${action}`).set(bearer(token)).send(body);

  beforeAll(async () => {
    ctx = await createTestApp();
    fx = await createOrg(ctx.prisma, 'Tables');
    other = await createOrg(ctx.prisma, 'TablesOther');
    for (const h of ['managerA', 'managerB', 'waiterA', 'cashierA', 'kitchenA']) tok[h] = await tokenFor(ctx, fx, h);
    tok.otherOwner = await tokenFor(ctx, other, 'owner');
    base = `${API}/branches/${fx.branchA}/tables`;
  });
  afterAll(() => ctx.close());

  describe('floor plan management', () => {
    it('managers add tables; waiters and kitchen staff cannot', async () => {
      for (const [label, capacity, posX] of [['T1', 2, 0], ['T2', 4, 100], ['T3', 4, 200], ['T4', 6, 300], ['T5', 2, 400]] as const) {
        const res = await ctx.http().post(base).set(bearer(tok.managerA)).send({ label, capacity, area: 'Main hall', posX, posY: 0 }).expect(201);
        expect(res.body.data).toEqual(expect.objectContaining({ label, status: 'AVAILABLE', session: null }));
        t[label] = res.body.data.id;
      }
      await ctx.http().post(base).set(bearer(tok.waiterA)).send({ label: 'W1', capacity: 2 }).expect(403);
      await ctx.http().get(base).set(bearer(tok.kitchenA)).expect(403);
      const dup = await ctx.http().post(base).set(bearer(tok.managerA)).send({ label: 'T1', capacity: 2 }).expect(409);
      expect(dup.body.error.code).toBe('UNIQUE_VIOLATION');
      await ctx.http().post(base).set(bearer(tok.managerA)).send({ label: 'T9', capacity: 0 }).expect(400);
    });

    it('saves a drag-and-drop layout in one request', async () => {
      const res = await ctx
        .http()
        .put(`${base}/layout`)
        .set(bearer(tok.managerA))
        .send({ tables: [{ id: t.T1, posX: 10, posY: 20, shape: 'ROUND' }, { id: t.T2, posX: 120, posY: 20, width: 120 }] })
        .expect(200);
      const t1 = res.body.data.find((x: TableView) => x.id === t.T1);
      expect(t1).toEqual(expect.objectContaining({ posX: 10, posY: 20, shape: 'ROUND' }));
      expect(res.body.data.find((x: TableView) => x.id === t.T2).width).toBe(120);
    });

    it('a layout touching another branch’s table is rejected as a whole', async () => {
      const b = await ctx.http().post(`${API}/branches/${fx.branchB}/tables`).set(bearer(tok.managerB)).send({ label: 'B1', capacity: 2 }).expect(201);
      await ctx
        .http()
        .put(`${base}/layout`)
        .set(bearer(tok.managerA))
        .send({ tables: [{ id: t.T1, posX: 999, posY: 999 }, { id: b.body.data.id, posX: 0, posY: 0 }] })
        .expect(404);
      expect((await view(t.T1)).posX).toBe(10);
    });

    it('optimistic concurrency: a stale version is refused', async () => {
      const cur = await view(t.T5);
      await ctx.http().patch(`${base}/${t.T5}`).set(bearer(tok.managerA)).send({ capacity: 3, version: cur.version }).expect(200);
      const stale = await ctx.http().patch(`${base}/${t.T5}`).set(bearer(tok.managerA)).send({ capacity: 5, version: cur.version }).expect(409);
      expect(stale.body.error.code).toBe('CONCURRENT_UPDATE');
    });
  });

  describe('table operations', () => {
    it('opens a table once; a second open is refused', async () => {
      const res = await op(t.T1, 'open', { guestCount: 2 }).expect(201);
      expect(res.body.data.status).toBe('OCCUPIED');
      expect(res.body.data.session).toEqual(expect.objectContaining({ guestCount: 2, mergedIntoTableId: null }));
      const again = await op(t.T1, 'open', { guestCount: 2 }).expect(409);
      expect(again.body.error.code).toBe('TABLE_NOT_AVAILABLE');
      await op(t.T2, 'open', { guestCount: 0 }).expect(400);
    });

    it('concurrent opens of the same table: exactly one wins', async () => {
      const results = await Promise.all(Array.from({ length: 6 }, () => op(t.T2, 'open', { guestCount: 3 })));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(5);
      expect(await ctx.prisma.tableSession.count({ where: { tableId: t.T2, closedAt: null } })).toBe(1);
    });

    it('transfers a party to an available table, keeping the session', async () => {
      const before = await view(t.T1);
      const res = await op(t.T1, 'transfer', { toTableId: t.T3 }).expect(200);
      expect(res.body.data.id).toBe(t.T3);
      expect(res.body.data.session.id).toBe(before.session!.id);
      expect((await view(t.T1)).status).toBe('AVAILABLE');
      const busy = await op(t.T3, 'transfer', { toTableId: t.T2 }).expect(409);
      expect(busy.body.error.code).toBe('TABLE_NOT_AVAILABLE');
      await op(t.T1, 'transfer', { toTableId: t.T4 }).expect(409); // nothing to transfer
    });

    it('merges tables: orders move to the main table, close is blocked until they are settled', async () => {
      const t2 = await view(t.T2);
      const order = await ctx.prisma.order.create({
        data: {
          organizationId: fx.orgId,
          branchId: fx.branchA,
          orderNumber: `T-${Date.now()}`,
          orderType: 'DINE_IN',
          tableSessionId: t2.session!.id,
          createdById: fx.users.waiterA.id,
        },
      });

      const res = await op(t.T3, 'merge', { tableIds: [t.T2] }).expect(200);
      expect(res.body.data.session.mergedTableIds).toEqual([t.T2]);
      const merged = await view(t.T2);
      expect(merged.session!.mergedIntoTableId).toBe(t.T3);
      const moved = await ctx.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(moved.tableSessionId).toBe(res.body.data.session.id);

      expect((await op(t.T2, 'close').expect(409)).body.error.code).toBe('TABLE_MERGED');
      expect((await op(t.T2, 'transfer', { toTableId: t.T4 }).expect(409)).body.error.code).toBe('TABLE_MERGED');
      const blocked = await op(t.T3, 'close').expect(409);
      expect(blocked.body.error.code).toBe('TABLE_HAS_OPEN_ORDERS');
      expect(blocked.body.error.details.orders[0].id).toBe(order.id);
      // An empty table cannot be merged; open it first.
      expect((await op(t.T3, 'merge', { tableIds: [t.T4] }).expect(409)).body.error.code).toBe('TABLE_NOT_OCCUPIED');

      await ctx.prisma.order.update({ where: { id: order.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
    });

    it('splits a merged table off and closes the group', async () => {
      const split = await op(t.T2, 'split').expect(200);
      expect(split.body.data.session.mergedIntoTableId).toBeNull();
      expect((await op(t.T2, 'split').expect(409)).body.error.code).toBe('TABLE_NOT_MERGED');

      await op(t.T3, 'merge', { tableIds: [t.T2] }).expect(200);
      await op(t.T3, 'close').expect(200);
      for (const id of [t.T2, t.T3]) {
        const v = await view(id);
        expect(v.status).toBe('AVAILABLE');
        expect(v.session).toBeNull();
      }
      expect(await ctx.prisma.tableSession.count({ where: { tableId: { in: [t.T2, t.T3] }, closedAt: null } })).toBe(0);
    });

    it('reservations: reserve, refuse past times, open clears the reservation', async () => {
      await op(t.T4, 'reserve', { name: 'Sharma party', until: new Date(Date.now() - 60_000).toISOString() }).expect(400);
      const until = new Date(Date.now() + 2 * 3600_000).toISOString();
      const res = await op(t.T4, 'reserve', { name: 'Sharma party', phone: '9876543210', until }).expect(200);
      expect(res.body.data).toEqual(expect.objectContaining({ status: 'RESERVED', reservationName: 'Sharma party', reservationExpired: false }));
      expect((await op(t.T4, 'reserve', { name: 'Other', until }).expect(409)).body.error.code).toBe('TABLE_NOT_AVAILABLE');
      const opened = await op(t.T4, 'open', { guestCount: 5 }).expect(201);
      expect(opened.body.data).toEqual(expect.objectContaining({ status: 'OCCUPIED', reservationName: null }));
      await op(t.T4, 'close').expect(200);

      await op(t.T5, 'reserve', { name: 'Walk-in hold', until }).expect(200);
      const cleared = await ctx.http().delete(`${base}/${t.T5}/reservation`).set(bearer(tok.waiterA)).expect(200);
      expect(cleared.body.data.status).toBe('AVAILABLE');
    });

    it('out of service blocks opening; only managers can toggle it', async () => {
      await ctx.http().patch(`${base}/${t.T1}/service-status`).set(bearer(tok.waiterA)).send({ outOfService: true }).expect(403);
      await ctx.http().patch(`${base}/${t.T1}/service-status`).set(bearer(tok.managerA)).send({ outOfService: true }).expect(200);
      expect((await op(t.T1, 'open', { guestCount: 2 }).expect(409)).body.error.code).toBe('TABLE_NOT_AVAILABLE');
      const back = await ctx.http().patch(`${base}/${t.T1}/service-status`).set(bearer(tok.managerA)).send({ outOfService: false }).expect(200);
      expect(back.body.data.status).toBe('AVAILABLE');
    });

    it('every operation is audited', async () => {
      const actions = await ctx.prisma.auditLog.findMany({
        where: { organizationId: fx.orgId, entityType: 'restaurant_table' },
        select: { action: true },
      });
      const set = new Set(actions.map((a) => a.action));
      for (const a of ['table.created', 'table.layout_saved', 'table.opened', 'table.transferred', 'table.merged', 'table.split', 'table.closed', 'table.reserved', 'table.unreserved', 'table.out_of_service']) {
        expect(set).toContain(a);
      }
    });
  });

  describe('deletion and isolation', () => {
    it('an occupied table cannot be deleted; a free one is soft-deleted and its label reusable', async () => {
      await op(t.T1, 'open', { guestCount: 1 }).expect(201);
      expect((await ctx.http().delete(`${base}/${t.T1}`).set(bearer(tok.managerA)).expect(409)).body.error.code).toBe('TABLE_IN_USE');
      await op(t.T1, 'close').expect(200);
      await ctx.http().delete(`${base}/${t.T1}`).set(bearer(tok.managerA)).expect(204);
      await ctx.http().get(`${base}/${t.T1}`).set(bearer(tok.managerA)).expect(404);
      expect((await ctx.prisma.restaurantTable.findUniqueOrThrow({ where: { id: t.T1 } })).deletedAt).toBeTruthy();
      await ctx.http().post(base).set(bearer(tok.managerA)).send({ label: 'T1', capacity: 2 }).expect(201);
    });

    it('other branches and organizations cannot reach these tables', async () => {
      await ctx.http().get(base).set(bearer(tok.managerB)).expect(403);
      await op(t.T2, 'open', { guestCount: 1 }, tok.managerB).expect(403);
      // Using branch B's URL with a branch A table id finds nothing.
      await ctx.http().post(`${API}/branches/${fx.branchB}/tables/${t.T2}/open`).set(bearer(tok.managerB)).send({ guestCount: 1 }).expect(404);
      await ctx.http().get(base).set(bearer(tok.otherOwner)).expect(404);
    });
  });
});
