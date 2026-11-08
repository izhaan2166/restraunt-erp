import { API, TestContext, createTestApp } from './helpers/app';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { createOrganization } from '../prisma/create-organization';
import { OrgFixture, bearer, createOrg, login, tokenFor } from './helpers/fixtures';

/** Operational endpoints: health, readiness and the Prometheus scrape. */
describe('Operations (e2e)', () => {
  let ctx: TestContext;
  let fx: OrgFixture;
  const METRICS = `${API}/metrics`;
  const token = { Authorization: 'Bearer test-metrics-token-0123456789abcdef' };

  beforeAll(async () => {
    ctx = await createTestApp();
    fx = await createOrg(ctx.prisma, 'Ops');
  });
  afterAll(() => ctx.close());

  it('reports liveness and readiness without logging in', async () => {
    await ctx.http().get(`${API}/health/live`).expect(200);
    const ready = await ctx.http().get(`${API}/health/ready`).expect(200);
    expect(ready.body.data).toEqual(
      expect.objectContaining({ status: 'ok', database: 'up', redis: process.env.TEST_REDIS_URL ? 'up' : 'not_configured' }),
    );
  });

  it('serves metrics only with the scrape token', async () => {
    await ctx.http().get(METRICS).expect(401);
    await ctx.http().get(METRICS).set({ Authorization: 'Bearer wrong' }).expect(401);
    const owner = await tokenFor(ctx, fx, 'owner');
    await ctx.http().get(METRICS).set(bearer(owner)).expect(401);
  });

  it('counts requests by route template, never by raw id', async () => {
    const owner = await tokenFor(ctx, fx, 'owner');
    const missing = '00000000-0000-4000-8000-000000000000';
    await ctx.http().get(`${API}/orders/${missing}`).set(bearer(owner)).expect(404);
    await ctx.http().get(`${API}/no-such-route`).expect(404);
    const res = await ctx.http().get(METRICS).set(token).expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    const text = res.text;
    expect(text).toMatch(/ros_http_requests_total\{[^}]*route="\/api\/v1\/orders\/:id"[^}]*status="404"[^}]*\} \d+/);
    expect(text).not.toContain(missing);
    expect(text).toMatch(/ros_http_request_duration_seconds_bucket\{/);
    expect(text).toMatch(/route="unmatched"/);
    expect(text).toMatch(/^ros_database_up\{[^}]*\} 1$/m);
    expect(text).toMatch(/^ros_realtime_outbox_backlog\{[^}]*\} \d+$/m);
    expect(text).toMatch(/^ros_process_resident_memory_bytes/m);
    // The response is raw Prometheus text, not the JSON envelope.
    expect(text.startsWith('{')).toBe(false);
  });

  it('sets up a real organization, branch and owner for a fresh install', async () => {
    const email = `owner.${randomUUID().slice(0, 8)}@spicegarden.example.in`;
    const env = {
      ORG_NAME: 'Spice Garden',
      ORG_LEGAL_NAME: 'Spice Garden Foods Pvt Ltd',
      ORG_STATE_CODE: '29',
      ORG_GSTIN: '29AABCS1234F1Z5',
      BRANCH_NAME: 'Indiranagar',
      BRANCH_CODE: `blr-${randomUUID().slice(0, 4)}`,
      OWNER_EMAIL: email,
      OWNER_NAME: 'Asha Rao',
      OWNER_PASSWORD: 'Sp1ceGarden!2026',
    };
    const db = ctx.prisma as unknown as PrismaClient;
    await expect(createOrganization(db, { ...env, OWNER_PASSWORD: 'short' })).rejects.toThrow(/OWNER_PASSWORD/);
    await expect(createOrganization(db, { ...env, ORG_GSTIN: '27AABCS1234F1Z5' })).rejects.toThrow(/GSTIN/);
    const r = await createOrganization(db, env);
    expect(r.created).toBe(true);
    // Running it again changes nothing.
    expect((await createOrganization(db, env)).created).toBe(false);

    const { accessToken } = await login(ctx, email, env.OWNER_PASSWORD);
    const branches = (await ctx.http().get(`${API}/branches`).set(bearer(accessToken)).expect(200)).body.data;
    expect(branches).toEqual([expect.objectContaining({ name: 'Indiranagar', code: env.BRANCH_CODE.toUpperCase(), stateCode: '29' })]);
    const org = (await ctx.http().get(`${API}/organization`).set(bearer(accessToken)).expect(200)).body.data;
    expect(org).toEqual(expect.objectContaining({ name: 'Spice Garden', gstin: '29AABCS1234F1Z5', pan: 'AABCS1234F' }));
  });
});
