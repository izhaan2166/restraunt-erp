import { API, TestContext, createTestApp } from './helpers/app';
import { OrgFixture, PASSWORD, bearer, createOrg, login } from './helpers/fixtures';

describe('Authentication (e2e)', () => {
  let ctx: TestContext;
  let fx: OrgFixture;

  beforeAll(async () => {
    ctx = await createTestApp();
    fx = await createOrg(ctx.prisma, 'Auth');
  });
  afterAll(() => ctx.close());

  describe('login', () => {
    it('issues an access + refresh token, opens a session and audits it', async () => {
      const res = await ctx
        .http()
        .post(`${API}/auth/login`)
        .send({ email: fx.users.cashierA.email.toUpperCase(), password: PASSWORD })
        .expect(200);

      expect(res.body.data).toEqual(
        expect.objectContaining({ accessToken: expect.any(String), refreshToken: expect.any(String), expiresIn: 900 }),
      );
      expect(res.headers['cache-control']).toBe('no-store');
      const cookie = String(res.headers['set-cookie']);
      expect(cookie).toMatch(/ros_rt=/);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Strict/i);
      expect(cookie).toMatch(/Path=\/api\/v1\/auth/);

      const sessions = await ctx.prisma.session.findMany({ where: { userId: fx.users.cashierA.id } });
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      // Only the hash of the refresh token is stored.
      const stored = await ctx.prisma.refreshToken.findMany({ where: { sessionId: { in: sessions.map((s) => s.id) } } });
      expect(stored.every((t) => t.tokenHash !== res.body.data.refreshToken && t.tokenHash.length === 64)).toBe(true);

      const audit = await ctx.prisma.auditLog.findFirst({
        where: { actorUserId: fx.users.cashierA.id, action: 'auth.login' },
      });
      expect(audit).not.toBeNull();
      const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: fx.users.cashierA.id } });
      expect(user.lastLoginAt).not.toBeNull();
    });

    it('rejects a wrong password and an unknown email with the same error', async () => {
      const wrong = await ctx.http().post(`${API}/auth/login`).send({ email: fx.users.waiterA.email, password: 'nope-nope-1' }).expect(401);
      const unknown = await ctx.http().post(`${API}/auth/login`).send({ email: 'ghost@nowhere.example', password: 'nope-nope-1' }).expect(401);
      expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(unknown.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(wrong.body.error.message).toBe(unknown.body.error.message);
      expect(wrong.body.error.requestId).toEqual(expect.any(String));
    });

    it('validates the request body', async () => {
      const res = await ctx.http().post(`${API}/auth/login`).send({ email: 'not-an-email', extra: 1 }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('locks the account after 5 failed attempts, even for the right password', async () => {
      const fresh = await createOrg(ctx.prisma, 'Lock');
      const email = fresh.users.waiterA.email;
      for (let i = 0; i < 5; i++) {
        await ctx.http().post(`${API}/auth/login`).send({ email, password: 'wrong-password-1' }).expect(401);
      }
      const locked = await ctx.http().post(`${API}/auth/login`).send({ email, password: PASSWORD }).expect(423);
      expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
      const u = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
      expect(u.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
      expect(await ctx.prisma.auditLog.count({ where: { entityId: u.id, action: 'auth.account_locked' } })).toBe(1);
    });

    it('refuses deactivated users', async () => {
      const fresh = await createOrg(ctx.prisma, 'Inactive');
      await ctx.prisma.user.update({ where: { id: fresh.users.waiterA.id }, data: { isActive: false } });
      await ctx.http().post(`${API}/auth/login`).send({ email: fresh.users.waiterA.email, password: PASSWORD }).expect(401);
    });
  });

  describe('access tokens', () => {
    it('requires a bearer token on protected routes', async () => {
      const res = await ctx.http().get(`${API}/auth/me`).expect(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
      await ctx.http().get(`${API}/auth/me`).set(bearer('garbage.token.value')).expect(401);
    });

    it('returns the profile with branch-scoped permissions', async () => {
      const { accessToken } = await login(ctx, fx.users.waiterA.email);
      const res = await ctx.http().get(`${API}/auth/me`).set(bearer(accessToken)).expect(200);
      const me = res.body.data;
      expect(me.user.email).toBe(fx.users.waiterA.email);
      expect(me.permissions.organizationWide).toEqual([]);
      expect(me.permissions.byBranch[fx.branchA]).toEqual(expect.arrayContaining(['orders.create', 'kot.submit']));
      expect(me.permissions.byBranch[fx.branchA]).not.toContain('billing.discount.apply');
      expect(me.branches.map((b: { id: string }) => b.id)).toEqual([fx.branchA]);
    });
  });

  describe('refresh token rotation', () => {
    it('rotates on every use and links the old token to its replacement', async () => {
      const first = await login(ctx, fx.users.cashierA.email);
      const res = await ctx.http().post(`${API}/auth/refresh`).send({ refreshToken: first.refreshToken }).expect(200);
      const second = res.body.data;
      expect(second.refreshToken).not.toBe(first.refreshToken);
      await ctx.http().get(`${API}/auth/me`).set(bearer(second.accessToken)).expect(200);

      const { createHash } = await import('node:crypto');
      const h = (t: string) => createHash('sha256').update(t).digest('hex');
      const old = await ctx.prisma.refreshToken.findUniqueOrThrow({ where: { tokenHash: h(first.refreshToken) } });
      const neu = await ctx.prisma.refreshToken.findUniqueOrThrow({ where: { tokenHash: h(second.refreshToken) } });
      expect(old.usedAt).not.toBeNull();
      expect(old.replacedById).toBe(neu.id);
      expect(old.sessionId).toBe(neu.sessionId);
    });

    it('treats reuse of a rotated token as theft and revokes the whole session', async () => {
      const first = await login(ctx, fx.users.cashierA.email);
      const rotated = (await ctx.http().post(`${API}/auth/refresh`).send({ refreshToken: first.refreshToken }).expect(200)).body.data;
      // The session has moved on (the replacement was used), so the old token can only be a replay.
      const third = (await ctx.http().post(`${API}/auth/refresh`).send({ refreshToken: rotated.refreshToken }).expect(200)).body.data;

      const reuse = await ctx.http().post(`${API}/auth/refresh`).send({ refreshToken: first.refreshToken }).expect(401);
      expect(reuse.body.error.code).toBe('REFRESH_TOKEN_REUSED');

      // The legitimate (newest) token and its access token are dead too.
      await ctx.http().post(`${API}/auth/refresh`).send({ refreshToken: third.refreshToken }).expect(401);
      await ctx.http().get(`${API}/auth/me`).set(bearer(third.accessToken)).expect(401);
      expect(
        await ctx.prisma.auditLog.count({ where: { actorUserId: fx.users.cashierA.id, action: 'auth.refresh_token_reuse' } }),
      ).toBeGreaterThanOrEqual(1);
    });

    it('accepts a just-rotated token once more within a few seconds (page reload or second tab racing the rotation)', async () => {
      const first = await login(ctx, fx.users.cashierA.email);
      await ctx.http().post(`${API}/auth/refresh`).send({ refreshToken: first.refreshToken }).expect(200);
      // The browser never stored the rotated cookie and sends the old one again.
      const again = (await ctx.http().post(`${API}/auth/refresh`).send({ refreshToken: first.refreshToken }).expect(200)).body.data;
      await ctx.http().get(`${API}/auth/me`).set(bearer(again.accessToken)).expect(200);
      await ctx.http().post(`${API}/auth/refresh`).send({ refreshToken: again.refreshToken }).expect(200);
    });

    it('treats the same replay as theft once the grace window has passed', async () => {
      const first = await login(ctx, fx.users.cashierA.email);
      const rotated = (await ctx.http().post(`${API}/auth/refresh`).send({ refreshToken: first.refreshToken }).expect(200)).body.data;
      const { createHash } = await import('node:crypto');
      await ctx.prisma.refreshToken.update({
        where: { tokenHash: createHash('sha256').update(first.refreshToken).digest('hex') },
        data: { usedAt: new Date(Date.now() - 60_000) },
      });
      expect((await ctx.http().post(`${API}/auth/refresh`).send({ refreshToken: first.refreshToken }).expect(401)).body.error.code).toBe('REFRESH_TOKEN_REUSED');
      await ctx.http().post(`${API}/auth/refresh`).send({ refreshToken: rotated.refreshToken }).expect(401);
    });

    it('lets two concurrent refreshes with the same token both succeed, rotating it only once', async () => {
      const first = await login(ctx, fx.users.managerA.email);
      const results = await Promise.all([
        ctx.http().post(`${API}/auth/refresh`).send({ refreshToken: first.refreshToken }),
        ctx.http().post(`${API}/auth/refresh`).send({ refreshToken: first.refreshToken }),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      const { createHash } = await import('node:crypto');
      const old = await ctx.prisma.refreshToken.findUniqueOrThrow({
        where: { tokenHash: createHash('sha256').update(first.refreshToken).digest('hex') },
      });
      expect(old.replacedById).not.toBeNull();
      expect(await ctx.prisma.refreshToken.count({ where: { sessionId: old.sessionId } })).toBe(3);
    });

    it('accepts the httpOnly cookie from an allowed origin and rejects foreign origins', async () => {
      const res = await ctx.http().post(`${API}/auth/login`).send({ email: fx.users.cashierA.email, password: PASSWORD });
      const cookie = (res.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
      await ctx.http().post(`${API}/auth/refresh`).set('Cookie', cookie).set('Origin', 'https://evil.example').expect(403);
      await ctx.http().post(`${API}/auth/refresh`).set('Cookie', cookie).set('Origin', 'http://localhost:3000').expect(200);
    });

    it('rejects unknown and missing refresh tokens', async () => {
      expect((await ctx.http().post(`${API}/auth/refresh`).send({}).expect(401)).body.error.code).toBe('REFRESH_TOKEN_MISSING');
      await ctx.http().post(`${API}/auth/refresh`).send({ refreshToken: 'made-up-token' }).expect(401);
    });
  });

  describe('logout', () => {
    it('revokes the session so its access and refresh tokens stop working at once', async () => {
      const t = await login(ctx, fx.users.waiterA.email);
      await ctx.http().post(`${API}/auth/logout`).send({ refreshToken: t.refreshToken }).expect(204);
      await ctx.http().get(`${API}/auth/me`).set(bearer(t.accessToken)).expect(401);
      await ctx.http().post(`${API}/auth/refresh`).send({ refreshToken: t.refreshToken }).expect(401);
    });

    it('logout-all signs out every device of the user', async () => {
      const a = await login(ctx, fx.users.kitchenA.email);
      const b = await login(ctx, fx.users.kitchenA.email);
      await ctx.http().post(`${API}/auth/logout-all`).set(bearer(a.accessToken)).expect(204);
      await ctx.http().get(`${API}/auth/me`).set(bearer(b.accessToken)).expect(401);
      const open = await ctx.prisma.session.count({ where: { userId: fx.users.kitchenA.id, revokedAt: null } });
      expect(open).toBe(0);
    });
  });

  describe('password reset', () => {
    it('answers identically for unknown emails and sends nothing', async () => {
      const before = ctx.mail.outbox.length;
      const res = await ctx.http().post(`${API}/auth/forgot-password`).send({ email: 'nobody@nowhere.example' }).expect(202);
      expect(res.body.data.message).toMatch(/If an account exists/);
      expect(ctx.mail.outbox.length).toBe(before);
    });

    it('resets with a single-use token and signs out existing sessions', async () => {
      const fresh = await createOrg(ctx.prisma, 'Reset');
      const email = fresh.users.cashierA.email;
      const oldSession = await login(ctx, email);

      await ctx.http().post(`${API}/auth/forgot-password`).send({ email }).expect(202);
      const mail = ctx.mail.outbox.filter((m) => m.to === email).pop()!;
      const token = decodeURIComponent(/token=([^\s]+)/.exec(mail.text)![1]);

      const weak = await ctx.http().post(`${API}/auth/reset-password`).send({ token, newPassword: 'short' }).expect(400);
      expect(weak.body.error.code).toBe('WEAK_PASSWORD');

      await ctx.http().post(`${API}/auth/reset-password`).send({ token, newPassword: 'BrandNewPass2026' }).expect(204);
      await ctx.http().post(`${API}/auth/reset-password`).send({ token, newPassword: 'AnotherPass2026' }).expect(400);

      await ctx.http().get(`${API}/auth/me`).set(bearer(oldSession.accessToken)).expect(401);
      await ctx.http().post(`${API}/auth/login`).send({ email, password: PASSWORD }).expect(401);
      await login(ctx, email, 'BrandNewPass2026');
    });
  });

  describe('change password', () => {
    it('requires the current password and keeps only the current session', async () => {
      const fresh = await createOrg(ctx.prisma, 'Change');
      const email = fresh.users.waiterA.email;
      const other = await login(ctx, email);
      const current = await login(ctx, email);
      await ctx
        .http()
        .post(`${API}/auth/change-password`)
        .set(bearer(current.accessToken))
        .send({ currentPassword: 'wrong', newPassword: 'Changed2026Pass' })
        .expect(400);
      await ctx
        .http()
        .post(`${API}/auth/change-password`)
        .set(bearer(current.accessToken))
        .send({ currentPassword: PASSWORD, newPassword: 'Changed2026Pass' })
        .expect(204);
      await ctx.http().get(`${API}/auth/me`).set(bearer(current.accessToken)).expect(200);
      await ctx.http().get(`${API}/auth/me`).set(bearer(other.accessToken)).expect(401);
    });
  });
});
