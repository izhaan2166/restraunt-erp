# Performance and load testing

## How to run

```bash
cd apps/api
pnpm load-test                                   # 1,200 orders, 25 concurrent clients, 300 reads per endpoint
LOAD_ORDERS=5000 LOAD_CONCURRENCY=50 LOAD_READS=500 pnpm load-test
```

The runner (`test/load/run.ts`):

1. Starts the real API: HTTP, guards, validation, audit log, realtime outbox and PostgreSQL triggers.
2. Creates a fresh organization with two branches in the test database.
3. Has concurrent cashiers in both branches create orders, send some to the kitchen, check out and pay. Payments are split between UPI, cash and card.
4. Hammers the dashboard, kitchen board, order and invoice lists, and the month's sales, product, GST and profit reports.

It prints p50, p95 and p99 per endpoint. It exits non-zero if any request fails, or if the number of invoices does not match the number of orders. CI runs a smaller version on every pull request.

## Results (2026-11-08)

Measured on a 4 vCPU container. The load generator, the API and PostgreSQL 16 all shared those 4 vCPUs. The API ran as a single Node 22 process, and Redis held the rate limits.

**One client at a time** (the latency a cashier feels):

| Endpoint | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|
| POST /orders | 28 | 44 | 55 |
| POST /orders/:id/confirm (KOT) | 27 | 39 | 44 |
| POST /billing/checkout | 35 | 55 | 66 |
| POST /invoices/:id/payments | 26 | 38 | 54 |
| GET /dashboard | 10 | 32 | 32 |
| GET /kot | 11 | 15 | 15 |
| GET /reports/sales (month, by day) | 7 | 13 | 13 |
| GET /reports/gst | 8 | 11 | 11 |
| GET /reports/profit-loss | 8 | 17 | 17 |

**25 concurrent clients, 1,200 orders and 2,400 reads:**

| Endpoint | n | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|
| POST /orders | 1200 | 238 | 360 | 431 |
| POST /orders/:id/confirm | 300 | 182 | 271 | 328 |
| POST /billing/checkout | 1200 | 270 | 394 | 468 |
| POST /invoices/:id/payments | 1200 | 223 | 320 | 368 |
| GET /dashboard | 300 | 120 | 159 | 174 |
| GET /kot | 300 | 120 | 160 | 178 |
| GET /reports/sales | 300 | 102 | 139 | 153 |
| GET /reports/products | 300 | 120 | 158 | 173 |

Throughput was **30.6 complete checkouts per second**. Each checkout is order, bill and payment: about 4 requests and 3 transactions. Reads ran at 218 requests per second. There were 0 failed requests and 0 server errors, and all 1,200 invoices were numbered without gaps.

### What the numbers mean

- **Under load, latency is mostly queueing.** With 25 clients on one process and 4 shared cores, each request waits for the ones ahead of it. Single-request latency is 25–35 ms for writes and about 10 ms for reads.
- **30 checkouts per second is about 108,000 bills an hour.** A busy 20-branch group at dinner peak does perhaps 1,500 bills an hour. That gives about 70 times headroom on one modest server.
- **Writes within one branch run one at a time.** This is deliberate: GST invoice numbers must be gap-free per branch, and the cash drawer balance is locked per shift. More branches spread the load. Within one branch, the limit is far above what one counter can do.
- **Reports stay fast** because every aggregate is a single SQL query over indexed columns (`facts.ts`). No index changes were needed, and no background jobs or cache. That decision is now settled in the checklist.

## Scaling further

1. **More API instances** behind the load balancer. The API is stateless; set `REDIS_URL` so rate limits are shared. Each instance needs its own `connection_limit` in `DATABASE_URL`, and the sum must stay below PostgreSQL's `max_connections`.
2. **A bigger database** before anything else. PostgreSQL does most of the work: locks, triggers and aggregates.
3. **A read replica for reports**, if multi-year exports ever compete with the counters. The report queries are read-only and take a branch list, so they can point at a replica without other changes.
