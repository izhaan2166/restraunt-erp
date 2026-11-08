/**
 * Load test: boots the real API (HTTP, PostgreSQL, guards, audit, realtime outbox) and drives it
 * with concurrent clients doing what a busy restaurant group does, then prints latency
 * percentiles per endpoint. See docs/performance.md for how to run it and the recorded results.
 *
 *   pnpm --filter api load-test                 # defaults
 *   LOAD_ORDERS=3000 LOAD_CONCURRENCY=40 pnpm --filter api load-test
 *
 * It uses the test database (TEST_DATABASE_URL) and creates its own organization each run.
 */
import '../helpers/env';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { loadEnv } from '../../src/config/env';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PASSWORD, createOrg } from '../helpers/fixtures';
import { seedMenu } from '../helpers/menu';

process.env.REALTIME_ENABLED ??= 'true';
const ORDERS = Number(process.env.LOAD_ORDERS ?? 1200);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 25);
const READS = Number(process.env.LOAD_READS ?? 300);

type Sample = { name: string; ms: number; status: number };
const samples: Sample[] = [];

async function main() {
  execSync('npx prisma migrate deploy', { stdio: 'pipe' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ bufferLogs: true });
  configureApp(app, loadEnv());
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1`;
  const prisma = app.get(PrismaService);
  const { seedReferenceData } = await import('../../prisma/seed');
  await seedReferenceData(prisma);

  const fx = await createOrg(prisma, 'Load');
  const menu = await seedMenu(prisma, fx);

  async function call(name: string, method: string, path: string, token: string, body?: object, idem = false) {
    const t0 = performance.now();
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(idem ? { 'Idempotency-Key': randomUUID() } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    samples.push({ name, ms: performance.now() - t0, status: res.status });
    if (res.status >= 400) throw new Error(`${name} ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text).data;
  }
  async function login(handle: string) {
    const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: fx.users[handle].email, password: PASSWORD }) });
    return ((await res.json()) as { data: { accessToken: string } }).data.accessToken;
  }
  const tok: Record<string, string> = {};
  for (const h of ['owner', 'cashierA', 'cashierB', 'kitchenA', 'managerA']) tok[h] = await login(h);
  for (const [h, b] of [['cashierA', fx.branchA], ['cashierB', fx.branchB]] as const) {
    await call('shift.open', 'POST', '/cash-sessions/open', tok[h], { branchId: b, openingBalance: '1000.00' }, true);
  }

  async function pool(n: number, worker: (i: number) => Promise<void>) {
    let next = 0;
    let failed = 0;
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (next < n) {
          const i = next++;
          await worker(i).catch((e) => {
            failed++;
            if (failed <= 5) console.error(String(e));
          });
        }
      }),
    );
    return failed;
  }

  const items = [
    [{ productId: menu.lassi, quantity: '2' }],
    [{ productId: menu.paneer.id, variantId: menu.paneer.full, quantity: '1', modifiers: [{ modifierId: menu.cheese }] }, { productId: menu.lassi, quantity: '1' }],
    [{ productId: menu.thali, quantity: '1', modifiers: [{ modifierId: menu.roti }] }],
  ];
  const methods = ['UPI', 'CASH', 'CARD'];

  console.log(`Writing ${ORDERS} orders with ${CONCURRENCY} concurrent clients across 2 branches…`);
  const t0 = performance.now();
  const writeFailures = await pool(ORDERS, async (i) => {
    const [branchId, token] = i % 2 ? [fx.branchB, tok.cashierB] : [fx.branchA, tok.cashierA];
    const o = await call('POST /orders', 'POST', '/orders', token, { branchId, orderType: 'TAKEAWAY', customerName: `Guest ${i}`, items: items[i % 3] }, true);
    if (i % 4 === 0) {
      await call('POST /orders/:id/confirm', 'POST', `/orders/${o.id}/confirm`, token, { version: o.version });
    }
    const inv = await call('POST /billing/checkout', 'POST', '/billing/checkout', token, { orderId: o.id, payments: [] }, true);
    await call('POST /invoices/:id/payments', 'POST', `/invoices/${inv.id}/payments`, token, { method: methods[i % 3], amount: inv.outstanding }, true);
  });
  const writeSecs = (performance.now() - t0) / 1000;

  const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 8)}01`;
  const reads: [string, string, string][] = [
    ['GET /dashboard', `/dashboard?range=today`, tok.owner],
    ['GET /kot', `/kot?branchId=${fx.branchA}`, tok.kitchenA],
    ['GET /orders', `/orders?branchId=${fx.branchA}&pageSize=50`, tok.managerA],
    ['GET /invoices', `/invoices?branchId=${fx.branchA}&pageSize=50`, tok.managerA],
    ['GET /reports/sales', `/reports/sales?from=${monthStart}&to=${today}&groupBy=day`, tok.owner],
    ['GET /reports/products', `/reports/products?from=${monthStart}&to=${today}`, tok.owner],
    ['GET /reports/gst', `/reports/gst?from=${monthStart}&to=${today}`, tok.owner],
    ['GET /reports/profit-loss', `/reports/profit-loss?from=${monthStart}&to=${today}`, tok.owner],
  ];
  console.log(`Reading: ${READS} requests per endpoint…`);
  const t1 = performance.now();
  const readFailures = await pool(READS * reads.length, async (i) => {
    const [name, path, token] = reads[i % reads.length];
    await call(name, 'GET', path, token);
  });
  const readSecs = (performance.now() - t1) / 1000;

  const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];
  const names = [...new Set(samples.map((s) => s.name))];
  const rows = names.map((name) => {
    const xs = samples.filter((s) => s.name === name).map((s) => s.ms).sort((a, b) => a - b);
    return { endpoint: name, n: xs.length, p50: pct(xs, 50).toFixed(1), p95: pct(xs, 95).toFixed(1), p99: pct(xs, 99).toFixed(1), max: xs[xs.length - 1].toFixed(1) };
  });
  console.table(rows);
  const invoices = await prisma.invoice.count({ where: { organizationId: fx.orgId } });
  console.log(
    JSON.stringify(
      {
        concurrency: CONCURRENCY,
        orders: ORDERS,
        invoicesCreated: invoices,
        writeFailures,
        readFailures,
        checkoutsPerSecond: Number((ORDERS / writeSecs).toFixed(1)),
        readsPerSecond: Number(((READS * reads.length) / readSecs).toFixed(1)),
        errors5xx: samples.filter((s) => s.status >= 500).length,
      },
      null,
      2,
    ),
  );
  await app.close();
  if (writeFailures || readFailures || invoices !== ORDERS) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
