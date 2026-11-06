import { API, TestContext, createTestApp } from './helpers/app';
import { OrgFixture, bearer, createOrg, login, tokenFor } from './helpers/fixtures';

describe('RBAC (e2e)', () => {
  let ctx: TestContext;
  let fx: OrgFixture;
  const tok: Record<string, string> = {};

  beforeAll(async () => {
    ctx = await createTestApp();
    fx = await createOrg(ctx.prisma, 'Rbac');
    for (const h of ['superAdmin', 'owner', 'managerA', 'managerB', 'cashierA', 'waiterA', 'kitchenA', 'accountant']) {
      tok[h] = await tokenFor(ctx, fx, h);
    }
  });
  afterAll(() => ctx.close());

  it('rejects users without the permission (waiter cannot list users)', async () => {
    const res = await ctx.http().get(`${API}/users`).set(bearer(tok.waiterA)).expect(403);
    expect(res.body.error).toEqual(
      expect.objectContaining({ code: 'MISSING_PERMISSION', details: expect.objectContaining({ missing: ['users.read'] }) }),
    );
  });

  it('kitchen staff cannot read roles; accountant cannot manage roles', async () => {
    await ctx.http().get(`${API}/roles`).set(bearer(tok.kitchenA)).expect(403);
    await ctx
      .http()
      .post(`${API}/roles`)
      .set(bearer(tok.accountant))
      .send({ key: 'X_ROLE', name: 'X', permissions: [] })
      .expect(403);
  });

  describe('branch scoping', () => {
    it('a branch manager sees users of their branch only', async () => {
      // Organization-wide listing needs an organization-wide grant.
      await ctx.http().get(`${API}/users`).set(bearer(tok.managerA)).expect(403);
      const res = await ctx.http().get(`${API}/users`).query({ branchId: fx.branchA }).set(bearer(tok.managerA)).expect(200);
      const ids = res.body.data.map((u: { id: string }) => u.id);
      expect(ids).toContain(fx.users.cashierA.id);
      expect(ids).not.toContain(fx.users.cashierB.id);
      expect(res.body.meta).toEqual(expect.objectContaining({ page: 1, pageSize: 25, total: ids.length }));

      await ctx.http().get(`${API}/users`).query({ branchId: fx.branchB }).set(bearer(tok.managerA)).expect(403);
      await ctx.http().get(`${API}/users`).set('X-Branch-Id', fx.branchB).set(bearer(tok.managerA)).expect(403);
    });

    it("hides other branches' users as not found", async () => {
      await ctx.http().get(`${API}/users/${fx.users.cashierA.id}`).set(bearer(tok.managerA)).expect(200);
      await ctx.http().get(`${API}/users/${fx.users.cashierB.id}`).set(bearer(tok.managerA)).expect(404);
    });

    it('a branch manager cannot read or edit another branch', async () => {
      await ctx.http().get(`${API}/branches/${fx.branchA}`).set(bearer(tok.managerA)).expect(200);
      await ctx.http().get(`${API}/branches/${fx.branchB}`).set(bearer(tok.managerA)).expect(403);
      const list = await ctx.http().get(`${API}/branches`).set(bearer(tok.managerA)).expect(200);
      expect(list.body.data.map((b: { id: string }) => b.id)).toEqual([fx.branchA]);
      const ownerList = await ctx.http().get(`${API}/branches`).set(bearer(tok.owner)).expect(200);
      expect(ownerList.body.data).toHaveLength(2);
    });

    it('rejects malformed branch ids', async () => {
      const res = await ctx.http().get(`${API}/users`).query({ branchId: 'not-a-uuid' }).set(bearer(tok.owner)).expect(400);
      expect(res.body.error.code).toBe('INVALID_BRANCH_ID');
    });
  });

  describe('user management and privilege escalation', () => {
    it('a manager can create a cashier in their own branch, recorded with the actor', async () => {
      const res = await ctx
        .http()
        .post(`${API}/users`)
        .set(bearer(tok.managerA))
        .send({
          email: `New.Cashier.${Date.now()}@test.restaurantos.local`,
          fullName: 'New Cashier',
          password: 'Cashier2026Pass',
          roles: [{ roleId: fx.roles.get('CASHIER'), branchId: fx.branchA }],
        })
        .expect(201);
      const created = res.body.data;
      expect(created.email).toBe(created.email.toLowerCase());
      expect(created.roles).toEqual([expect.objectContaining({ roleKey: 'CASHIER', branchId: fx.branchA })]);
      const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: created.id }, include: { userRoles: true } });
      expect(row.createdById).toBe(fx.users.managerA.id);
      expect(row.userRoles[0].assignedById).toBe(fx.users.managerA.id);
      expect(row.passwordHash).toMatch(/^\$argon2id\$/);
      const audit = await ctx.prisma.auditLog.findFirst({ where: { action: 'user.created', entityId: created.id } });
      expect(audit?.actorUserId).toBe(fx.users.managerA.id);
      expect(JSON.stringify(audit?.after)).not.toContain('Cashier2026Pass');
      // the new user can log in
      await login(ctx, created.email, 'Cashier2026Pass');
    });

    it('a manager cannot create users in another branch or organization-wide', async () => {
      for (const branchId of [fx.branchB, null]) {
        await ctx
          .http()
          .post(`${API}/users`)
          .set(bearer(tok.managerA))
          .send({
            email: `x.${Date.now()}.${branchId ?? 'org'}@test.restaurantos.local`,
            fullName: 'Nope',
            password: 'Cashier2026Pass',
            roles: [{ roleId: fx.roles.get('CASHIER'), branchId }],
          })
          .expect(403);
      }
    });

    it('a manager cannot grant a role with permissions they do not hold', async () => {
      const res = await ctx
        .http()
        .post(`${API}/users/${fx.users.cashierA.id}/roles`)
        .set(bearer(tok.managerA))
        .send({ roleId: fx.roles.get('ACCOUNTANT'), branchId: fx.branchA })
        .expect(403);
      expect(res.body.error.code).toBe('PRIVILEGE_ESCALATION');
      expect(res.body.error.details.missing).toEqual(expect.arrayContaining(['reports.gst']));
    });

    it('only a Super Admin can grant Super Admin', async () => {
      const res = await ctx
        .http()
        .post(`${API}/users/${fx.users.accountant.id}/roles`)
        .set(bearer(tok.owner))
        .send({ roleId: fx.roles.get('SUPER_ADMIN'), branchId: null })
        .expect(403);
      expect(res.body.error.code).toBe('PRIVILEGE_ESCALATION');
    });

    it('a manager cannot modify an organization-wide user', async () => {
      await ctx
        .http()
        .patch(`${API}/users/${fx.users.accountant.id}`)
        .set(bearer(tok.managerA))
        .send({ fullName: 'Hacked' })
        .expect(404);
    });

    it('rejects weak passwords and duplicate emails', async () => {
      const base = { fullName: 'Dup', roles: [{ roleId: fx.roles.get('WAITER'), branchId: fx.branchA }] };
      const weak = await ctx
        .http()
        .post(`${API}/users`)
        .set(bearer(tok.owner))
        .send({ ...base, email: `weak.${Date.now()}@test.restaurantos.local`, password: 'password' })
        .expect(400);
      expect(weak.body.error.code).toBe('WEAK_PASSWORD');
      const dup = await ctx
        .http()
        .post(`${API}/users`)
        .set(bearer(tok.owner))
        .send({ ...base, email: fx.users.waiterA.email, password: 'Waiter2026Pass' })
        .expect(409);
      expect(dup.body.error.code).toBe('EMAIL_TAKEN');
    });

    it('deactivating a user signs them out immediately', async () => {
      const fresh = await createOrg(ctx.prisma, 'Deact');
      const victim = await login(ctx, fresh.users.waiterA.email);
      const mgr = await tokenFor(ctx, fresh, 'managerA');
      await ctx.http().get(`${API}/auth/me`).set(bearer(victim.accessToken)).expect(200);
      await ctx.http().patch(`${API}/users/${fresh.users.waiterA.id}`).set(bearer(mgr)).send({ isActive: false }).expect(200);
      await ctx.http().get(`${API}/auth/me`).set(bearer(victim.accessToken)).expect(401);
      await ctx.http().post(`${API}/auth/refresh`).send({ refreshToken: victim.refreshToken }).expect(401);
    });

    it('keeps at least one Super Admin', async () => {
      const fresh = await createOrg(ctx.prisma, 'LastAdmin');
      const admin = await tokenFor(ctx, fresh, 'superAdmin');
      const me = await ctx.http().get(`${API}/users/${fresh.users.superAdmin.id}`).set(bearer(admin)).expect(200);
      const assignment = me.body.data.roles.find((r: { roleKey: string }) => r.roleKey === 'SUPER_ADMIN');
      const res = await ctx
        .http()
        .delete(`${API}/users/${fresh.users.superAdmin.id}/roles/${assignment.assignmentId}`)
        .set(bearer(admin))
        .expect(409);
      expect(res.body.error.code).toBe('LAST_SUPER_ADMIN');
    });
  });

  describe('configurable roles', () => {
    it('changing a role takes effect on the next request and is audited with before/after', async () => {
      const fresh = await createOrg(ctx.prisma, 'Config');
      const owner = await tokenFor(ctx, fresh, 'owner');
      const managerA = await tokenFor(ctx, fresh, 'managerA');
      const roleId = fresh.roles.get('MANAGER')!;

      await ctx.http().get(`${API}/users`).query({ branchId: fresh.branchA }).set(bearer(managerA)).expect(200);
      const role = (await ctx.http().get(`${API}/roles/${roleId}`).set(bearer(owner)).expect(200)).body.data;
      const without = role.permissions.filter((p: string) => p !== 'users.read');
      await ctx.http().put(`${API}/roles/${roleId}/permissions`).set(bearer(owner)).send({ permissions: without }).expect(200);

      // Same access token, permissions re-evaluated server-side.
      await ctx.http().get(`${API}/users`).query({ branchId: fresh.branchA }).set(bearer(managerA)).expect(403);

      const audit = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'role.permissions_updated', entityId: roleId },
      });
      expect((audit.before as { permissions: string[] }).permissions).toContain('users.read');
      expect((audit.after as { permissions: string[] }).permissions).not.toContain('users.read');
      expect(audit.actorUserId).toBe(fresh.users.owner.id);
    });

    it('the Super Admin role cannot be edited and system roles cannot be deleted', async () => {
      const r1 = await ctx
        .http()
        .put(`${API}/roles/${fx.roles.get('SUPER_ADMIN')}/permissions`)
        .set(bearer(tok.superAdmin))
        .send({ permissions: [] })
        .expect(403);
      expect(r1.body.error.code).toBe('ROLE_IMMUTABLE');
      await ctx.http().delete(`${API}/roles/${fx.roles.get('CASHIER')}`).set(bearer(tok.superAdmin)).expect(403);
    });

    it('custom roles: unknown permissions rejected; cannot grant what you lack; deletable when unused', async () => {
      const unknown = await ctx
        .http()
        .post(`${API}/roles`)
        .set(bearer(tok.owner))
        .send({ key: 'BAD_ROLE', name: 'Bad', permissions: ['orders.teleport'] })
        .expect(400);
      expect(unknown.body.error.code).toBe('UNKNOWN_PERMISSION');

      // Give the accountant role-management rights; they still cannot hand out what they lack.
      const fresh = await createOrg(ctx.prisma, 'Escalate');
      const admin = await tokenFor(ctx, fresh, 'superAdmin');
      const accRoleId = fresh.roles.get('ACCOUNTANT')!;
      const accRole = (await ctx.http().get(`${API}/roles/${accRoleId}`).set(bearer(admin)).expect(200)).body.data;
      await ctx
        .http()
        .put(`${API}/roles/${accRoleId}/permissions`)
        .set(bearer(admin))
        .send({ permissions: [...accRole.permissions, 'roles.read', 'roles.manage'] })
        .expect(200);
      const accountant = await tokenFor(ctx, fresh, 'accountant');
      const esc = await ctx
        .http()
        .post(`${API}/roles`)
        .set(bearer(accountant))
        .send({ key: 'EXPO', name: 'Expo', permissions: ['kot.update_status'] })
        .expect(403);
      expect(esc.body.error.code).toBe('PRIVILEGE_ESCALATION');
      // ...nor strip permissions they lack from an existing role.
      const strip = await ctx
        .http()
        .put(`${API}/roles/${fresh.roles.get('KITCHEN_STAFF')}/permissions`)
        .set(bearer(accountant))
        .send({ permissions: ['notifications.read'] })
        .expect(403);
      expect(strip.body.error.code).toBe('PRIVILEGE_ESCALATION');

      const created = await ctx
        .http()
        .post(`${API}/roles`)
        .set(bearer(tok.owner))
        .send({ key: 'SHIFT_LEAD', name: 'Shift Lead', permissions: ['orders.read', 'orders.cancel'] })
        .expect(201);
      expect(created.body.data).toEqual(
        expect.objectContaining({ key: 'SHIFT_LEAD', isSystem: false, permissions: ['orders.cancel', 'orders.read'] }),
      );
      const dup = await ctx
        .http()
        .post(`${API}/roles`)
        .set(bearer(tok.owner))
        .send({ key: 'SHIFT_LEAD', name: 'Again', permissions: [] })
        .expect(409);
      expect(dup.body.error.code).toBe('UNIQUE_VIOLATION');
      await ctx.http().delete(`${API}/roles/${created.body.data.id}`).set(bearer(tok.owner)).expect(204);
    });

    it('exposes the permission catalog', async () => {
      const res = await ctx.http().get(`${API}/permissions`).set(bearer(tok.owner)).expect(200);
      expect(res.body.data.map((p: { code: string }) => p.code)).toEqual(
        expect.arrayContaining(['billing.discount.override', 'refunds.approve', 'orders.cancel', 'menu.price.update']),
      );
    });
  });

  describe('audit log', () => {
    it('is readable by the owner, scoped to the organization, and append-only in the database', async () => {
      const res = await ctx.http().get(`${API}/audit-logs`).query({ pageSize: 100 }).set(bearer(tok.owner)).expect(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      const orgIds = new Set(res.body.data.map((r: { organizationId: string }) => r.organizationId));
      expect([...orgIds]).toEqual([fx.orgId]);
      await ctx.http().get(`${API}/audit-logs`).set(bearer(tok.cashierA)).expect(403);

      await expect(ctx.prisma.auditLog.updateMany({ data: { action: 'tampered' } })).rejects.toThrow(/append-only/);
      await expect(ctx.prisma.auditLog.deleteMany({})).rejects.toThrow(/append-only/);
    });
  });
});
