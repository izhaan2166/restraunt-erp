import { API, TestContext, createTestApp } from './helpers/app';
import { OrgFixture, bearer, createOrg, tokenFor } from './helpers/fixtures';

/** Two restaurants on the same installation must never see each other's data. */
describe('Multi-tenant isolation (e2e)', () => {
  let ctx: TestContext;
  let a: OrgFixture;
  let b: OrgFixture;
  let adminB: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    [a, b] = await Promise.all([createOrg(ctx.prisma, 'Alpha'), createOrg(ctx.prisma, 'Beta')]);
    adminB = await tokenFor(ctx, b, 'superAdmin');
  });
  afterAll(() => ctx.close());

  it("another organization's branch is reported as not found, by path, query or header", async () => {
    await ctx.http().get(`${API}/branches/${a.branchA}`).set(bearer(adminB)).expect(404);
    await ctx.http().get(`${API}/users`).query({ branchId: a.branchA }).set(bearer(adminB)).expect(404);
    await ctx.http().get(`${API}/audit-logs`).set('X-Branch-Id', a.branchA).set(bearer(adminB)).expect(404);
    await ctx.http().patch(`${API}/branches/${a.branchA}`).set(bearer(adminB)).send({ name: 'pwned' }).expect(404);
    const branch = await ctx.prisma.branch.findUniqueOrThrow({ where: { id: a.branchA } });
    expect(branch.name).not.toBe('pwned');
  });

  it("another organization's users and roles are invisible", async () => {
    await ctx.http().get(`${API}/users/${a.users.owner.id}`).set(bearer(adminB)).expect(404);
    await ctx.http().patch(`${API}/users/${a.users.owner.id}`).set(bearer(adminB)).send({ isActive: false }).expect(404);
    await ctx.http().get(`${API}/roles/${a.roles.get('OWNER')}`).set(bearer(adminB)).expect(404);

    const list = await ctx.http().get(`${API}/users`).query({ pageSize: 100 }).set(bearer(adminB)).expect(200);
    const emails: string[] = list.body.data.map((u: { email: string }) => u.email);
    expect(emails).not.toContain(a.users.owner.email);
    expect(list.body.meta.total).toBe(Object.keys(b.users).length);
  });

  it("cannot attach another organization's role or branch to its own users", async () => {
    await ctx
      .http()
      .post(`${API}/users/${b.users.waiterA.id}/roles`)
      .set(bearer(adminB))
      .send({ roleId: a.roles.get('OWNER'), branchId: null })
      .expect(404);
    await ctx
      .http()
      .post(`${API}/users/${b.users.waiterA.id}/roles`)
      .set(bearer(adminB))
      .send({ roleId: b.roles.get('CASHIER'), branchId: a.branchA })
      .expect(404);
    expect(await ctx.prisma.userRole.count({ where: { userId: b.users.waiterA.id } })).toBe(1);
  });

  it('the database rejects a role assignment whose role belongs to a different organization', async () => {
    // Defence in depth: composite foreign keys (role_id, organization_id) stop cross-tenant rows
    // even if application code had a bug.
    await expect(
      ctx.prisma.userRole.create({
        data: { organizationId: b.orgId, userId: b.users.waiterA.id, roleId: a.roles.get('OWNER')! },
      }),
    ).rejects.toThrow();
  });

  it('the audit log of one organization does not show the other', async () => {
    const res = await ctx.http().get(`${API}/audit-logs`).query({ pageSize: 100 }).set(bearer(adminB)).expect(200);
    for (const row of res.body.data) expect(row.organizationId).toBe(b.orgId);
  });

  it('both organizations work at the same time', async () => {
    const adminA = await tokenFor(ctx, a, 'superAdmin');
    const [ra, rb] = await Promise.all([
      ctx.http().get(`${API}/branches`).set(bearer(adminA)),
      ctx.http().get(`${API}/branches`).set(bearer(adminB)),
    ]);
    expect(ra.body.data.map((x: { id: string }) => x.id).sort()).toEqual([a.branchA, a.branchB].sort());
    expect(rb.body.data.map((x: { id: string }) => x.id).sort()).toEqual([b.branchA, b.branchB].sort());
  });
});
