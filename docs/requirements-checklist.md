# Requirements checklist

Status: ✅ done and tested · 🟡 designed (schema/contract in place), behaviour in a later phase · ⏳ not started · ❌ failing

_Last updated: Phase 1._

## Phase 1 – Architecture, schema, authentication, RBAC

| Requirement | Status | Evidence |
|---|---|---|
| System architecture documented | ✅ | `docs/architecture.md` |
| ER diagram | ✅ | `docs/database.md` |
| API contracts | ✅ | `docs/api-contracts.md`, `docs/openapi.json` |
| Complete normalized PostgreSQL schema for all modules (§4.2) | ✅ | `schema.prisma` (64 tables), migrations apply cleanly, no drift |
| PKs, FKs, unique constraints, indexes, check constraints, timestamps | ✅ | migrations; `test/db-integrity.e2e-spec.ts` |
| Money as NUMERIC, never float | ✅ | schema; decimal round-trip test |
| Every restaurant-owned record tied to organization (and branch) | ✅ | composite FKs; isolation tests |
| Migrations and seed scripts | ✅ | `prisma/migrations`, `prisma/seed.ts` |
| Every user authenticated (JWT + refresh tokens) | ✅ | `test/auth.e2e-spec.ts` |
| Argon2id password hashing | ✅ | `password.service.spec.ts` |
| Short-lived access tokens, refresh rotation with reuse detection | ✅ | auth e2e |
| Forgot / reset password | ✅ | auth e2e |
| Account lockout and auth rate limiting | ✅ | auth e2e (lockout); throttler configured |
| RBAC with the 8 roles; configurable permissions | ✅ | `default-roles.spec.ts`, `test/rbac.e2e-spec.ts` |
| Users only access authorized modules; enforced server-side, deny by default | ✅ | `permissions.guard.spec.ts`, rbac e2e |
| Prevent privilege escalation | ✅ | rbac e2e |
| Separate permissions for discounts, refunds, cancellations, price changes | ✅ | catalog + matrix test |
| Record who performs important operations | ✅ | `audit_logs` (append-only), actor columns |
| Organization and branch isolation | ✅ | `test/isolation.e2e-spec.ts` |
| Consistent responses, status codes, central error handling, request logging | ✅ | filter, interceptor, pino |
| Validation, CORS, Helmet headers, secrets in env | ✅ | `bootstrap.ts`, `config/env.ts` |
| CSRF protection for cookie auth | ✅ | SameSite=Strict + Origin check (auth e2e) |
| Swagger / OpenAPI | ✅ | `/api/docs` |
| Docker + env example + CI | ✅ | `docker-compose.yml`, `apps/api/Dockerfile`, `.env.example`, `.github/workflows/ci.yml` |
| Finalized invoices immutable; ledgers append-only (DB level) | ✅ | triggers + integrity tests |
| Email delivery for password reset | 🟡 | Log transport only; SMTP/SES transport in Phase 8 |
| Redis-backed rate limit / permission cache | 🟡 | In-memory throttler for now (single instance); Redis in Phase 4 with WebSockets |

## Later phases

| Phase | Area | Status |
|---|---|---|
| 2 | Menu, categories, products, variants, add-ons, branch pricing, combos, tables & floor plan | 🟡 schema ready |
| 3 | POS, orders & state machine, billing engine, GST, invoices, split/partial payments, refunds, credit notes, idempotency | 🟡 schema ready |
| 4 | KDS, stations, WebSocket events, reconnect/resync | 🟡 schema ready |
| 5 | Inventory ledger, recipes/BOM, unit conversion, suppliers, purchase orders, goods receipts | 🟡 schema ready |
| 6 | Expenses, employees, attendance, cash shifts & reconciliation | 🟡 schema ready |
| 7 | Dashboard, reports, CSV/PDF exports | ⏳ |
| 8 | Hardening, load tests, monitoring, deployment & backup runbooks, admin/user docs | ⏳ |
| 2+ | Next.js frontend | ⏳ |
