# RestaurantOS – Restaurant ERP & POS

A production-oriented restaurant ERP for the Indian market: dine-in, takeaway and delivery
billing, KOT and kitchen display, GST invoicing (CGST/SGST/IGST, HSN/SAC), inventory with
recipes, purchasing, expenses, staff, cash shifts, reports, and multi-branch management.

Built in phases, each implemented and tested before the next. **Done: Phase 1 (architecture,
schema, authentication, RBAC), Phase 2 (menu, branch pricing, add-ons, combos, tables and
floor plan), Phase 3 (orders, KOTs, billing engine, GST invoices, split payments, refunds,
credit notes), Phase 4 (kitchen display, WebSocket realtime events with safe reconnect), Phase 5
(inventory, recipes with automatic stock deduction, suppliers, purchase orders, goods receipts,
supplier bills and payments), Phase 6 (expenses with receipts, employees, attendance, cash
shifts with reconciliation), Phase 7 (dashboard, sales/GST/stock/profit/staff reports, CSV and
PDF exports, invoice PDF) and Phase 8 (security hardening, Redis rate limits, SMTP email, private
receipts, Prometheus metrics and alerts, end-to-end and load tests, production deployment with
HTTPS, backups and restore, admin and user guides).** Frontend part 1 is done: the Next.js staff
app with sign-in, POS (dine-in, takeaway, delivery, bill and payment), kitchen display, live table
floor and orders list. Frontend part 2 is done: owner and manager screens for the menu, staff and
roles, table layout and branches. Frontend part 3 is done: stock, recipes, suppliers and purchase
orders. Frontend part 4 is done: cash drawer, expenses with receipts, supplier bills and payments,
employees, attendance and clock in/out. Next: dashboard and report screens.

| | |
|---|---|
| Architecture | [docs/architecture.md](docs/architecture.md) |
| Database & ER diagrams | [docs/database.md](docs/database.md) |
| API contracts | [docs/api-contracts.md](docs/api-contracts.md) · Swagger at `/api/docs` |
| Billing & GST rules | [docs/billing.md](docs/billing.md) |
| Inventory & purchasing rules | [docs/inventory.md](docs/inventory.md) |
| Cash, expenses & staff rules | [docs/cash-and-staff.md](docs/cash-and-staff.md) |
| Reports & dashboard definitions | [docs/reports.md](docs/reports.md) |
| Deployment (HTTPS, one server or cloud) | [docs/deployment.md](docs/deployment.md) |
| Backups & restore | [docs/backup-restore.md](docs/backup-restore.md) |
| Monitoring, alerts & runbooks | [docs/monitoring.md](docs/monitoring.md) |
| Security | [docs/security.md](docs/security.md) |
| Performance & load test | [docs/performance.md](docs/performance.md) |
| Admin guide · User guide | [docs/admin-guide.md](docs/admin-guide.md) · [docs/user-guide.md](docs/user-guide.md) |
| Progress | [docs/requirements-checklist.md](docs/requirements-checklist.md) |

## Stack

NestJS 11 · TypeScript (strict) · PostgreSQL 16 · Prisma 6 · Argon2id · JWT + rotating refresh
tokens · class-validator · pino · socket.io WebSockets · S3-compatible storage · Jest + Supertest ·
Redis (shared rate limits) · prom-client · Docker + Caddy. Web: Next.js 16 (App Router) · React 19 ·
Tailwind CSS 4 · TanStack Query · socket.io client · Playwright + Vitest.

## Quick start (local)

Requirements: Node 22+, pnpm 10, PostgreSQL 16 (or Docker).

```bash
pnpm install
cp .env.example apps/api/.env          # set JWT_ACCESS_SECRET (openssl rand -base64 48)
docker compose up -d postgres redis    # or use a local PostgreSQL

cd apps/api
pnpm prisma:generate
pnpm prisma:migrate                    # apply migrations
SEED_DEMO=true pnpm db:seed            # reference data + demo organization
pnpm start:dev                         # http://localhost:4000/api/v1, docs at /api/docs

cd ../web                              # in a second terminal
pnpm dev                               # staff app at http://localhost:3000
```

The web app forwards `/api`, `/realtime` and `/uploads` to the API (`API_ORIGIN`, default
`http://localhost:4000`), so the browser talks to one origin and the sign-in cookie just works.

Demo users (password `ChangeMe@2026`, override with `SEED_DEFAULT_PASSWORD`):
`admin@`, `owner@`, `accountant@`, `manager.blr@`, `cashier.blr@`, `waiter.blr@`,
`kitchen.blr@`, `inventory.blr@`, `manager.mum@`, `cashier.mum@` — all `@demo.restaurantos.local`.

```bash
curl -s localhost:4000/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"owner@demo.restaurantos.local","password":"ChangeMe@2026"}'
```

## Full stack with Docker

```bash
cp .env.example .env    # edit secrets
docker compose up --build
```

`migrate` applies migrations and seeds reference data, then `api` starts on port 4000 and the
web app on port 3000.

## Tests

```bash
cd apps/api
pnpm test        # unit tests
pnpm test:e2e    # integration tests against a real PostgreSQL (TEST_DATABASE_URL,
                 # default postgresql://ros:ros_dev_password@localhost:5432/restaurant_os_test)
                 # set TEST_REDIS_URL=redis://localhost:6379/15 to run them on Redis too
pnpm load-test   # load test with latency percentiles (docs/performance.md)
```

```bash
cd apps/web
pnpm test        # unit tests (API client, formatting)
pnpm test:e2e    # browser tests: builds the API's database from scratch (E2E_DATABASE_URL, default
                 # .../restaurant_os_e2e), starts the API and the app, and drives real screens:
                 # waiter → kitchen (live) → cashier cash + UPI, takeaway, permissions, reloads
```

Integration tests run the real HTTP stack (guards, validation, error filter) against a migrated
database and assert on database state, not only on responses.

## Project layout

```
apps/api     NestJS API: prisma/ (schema, migrations, seed), src/ (modules), test/ (e2e, load)
apps/web     Next.js staff app: src/app (screens), src/lib (API client, session, realtime), e2e/
ops/         production compose + Caddy, backup/restore scripts, Prometheus config and alerts
docs/        architecture, database, API contracts, operations guides, checklist, openapi.json
```
