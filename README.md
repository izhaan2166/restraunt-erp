# RestaurantOS – Restaurant ERP & POS

A production-oriented restaurant ERP for the Indian market: dine-in, takeaway and delivery
billing, KOT and kitchen display, GST invoicing (CGST/SGST/IGST, HSN/SAC), inventory with
recipes, purchasing, expenses, staff, cash shifts, reports, and multi-branch management.

Built in phases, each implemented and tested before the next. **Current: Phase 1 –
architecture, database schema, authentication and RBAC.**

| | |
|---|---|
| Architecture | [docs/architecture.md](docs/architecture.md) |
| Database & ER diagrams | [docs/database.md](docs/database.md) |
| API contracts | [docs/api-contracts.md](docs/api-contracts.md) · Swagger at `/api/docs` |
| Progress | [docs/requirements-checklist.md](docs/requirements-checklist.md) |

## Stack

NestJS 11 · TypeScript (strict) · PostgreSQL 16 · Prisma 6 · Argon2id · JWT + rotating refresh
tokens · class-validator · pino · Jest + Supertest · Docker. Coming in later phases: Next.js +
Tailwind + shadcn/ui, Redis, WebSockets, BullMQ, S3-compatible storage.

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
```

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

`migrate` applies migrations and seeds reference data, then `api` starts on port 4000.

## Tests

```bash
cd apps/api
pnpm test        # unit tests
pnpm test:e2e    # integration tests against a real PostgreSQL (TEST_DATABASE_URL,
                 # default postgresql://ros:ros_dev_password@localhost:5432/restaurant_os_test)
```

Integration tests run the real HTTP stack (guards, validation, error filter) against a migrated
database and assert on database state, not only on responses.

## Project layout

```
apps/api     NestJS API: prisma/ (schema, migrations, seed), src/ (modules), test/ (e2e)
docs/        architecture, database, API contracts, requirements checklist, openapi.json
```
