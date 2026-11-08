# Requirements checklist

Status: ✅ done and tested · 🟡 designed (schema/contract in place), behaviour in a later phase · ⏳ not started · ❌ failing

_Last updated: Phase 2._

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

## Phase 2 – Menu and tables

| Requirement | Status | Evidence |
|---|---|---|
| Categories (nested, ordered, soft delete, not deletable while in use) | ✅ | `test/menu.e2e-spec.ts` |
| Products with SKU, HSN/SAC, veg flag, tax rate, kitchen station, image | ✅ | menu e2e |
| Variants (Half/Full…), exactly one default | ✅ | menu e2e, `variants.spec.ts`, DB unique index |
| Add-ons (modifier groups with min/max selection) | ✅ | menu e2e |
| Combos (no nesting, no self-reference, contents protected from deletion) | ✅ | menu e2e |
| GST tax rates with derived CGST/SGST/IGST; immutable once created | ✅ | menu e2e |
| Branch-specific prices and availability | ✅ | menu e2e, `pricing.spec.ts` |
| Price changes need `menu.price.update` (org prices org-wide, branch prices per branch); audited with before/after | ✅ | menu e2e |
| Temporary unavailability ("86") by kitchen staff for their branch | ✅ | menu e2e (`menu.availability.update`) |
| POS menu endpoint with resolved branch prices | ✅ | `GET /menu?branchId=` |
| Image upload validated by content and size; S3-compatible or local storage | ✅ | menu e2e, `image-validation.spec.ts` |
| Kitchen stations per branch | ✅ | menu e2e |
| Tables & floor plan (layout editor save, shapes, areas) | ✅ | `test/tables.e2e-spec.ts` |
| Table states: available, occupied, reserved, out of service | ✅ | tables e2e |
| Open, transfer, merge, split, close tables; close blocked by unsettled orders | ✅ | tables e2e |
| Reservations (name, phone, hold-until) | ✅ | tables e2e |
| Concurrency: one open session per table under simultaneous requests; stale-version updates refused | ✅ | tables e2e (6 parallel opens → 1 wins), row locks + partial unique index |
| Menu and tables isolated per organization/branch | ✅ | menu & tables e2e |
| Demo seed: sample menu and floor plans for the demo organization | ✅ | `prisma/seed.ts` (`SEED_DEMO=true`) |
| `BILL_PENDING` table status | 🟡 | Set by checkout in Phase 3 |
| Real-time floor plan updates | 🟡 | WebSocket events in Phase 4 |

## Later phases

| Phase | Area | Status |
|---|---|---|
| 3 | POS, orders & state machine, billing engine, GST, invoices, split/partial payments, refunds, credit notes, idempotency | 🟡 schema ready |
| 4 | KDS, stations, WebSocket events, reconnect/resync | 🟡 schema ready |
| 5 | Inventory ledger, recipes/BOM, unit conversion, suppliers, purchase orders, goods receipts | 🟡 schema ready |
| 6 | Expenses, employees, attendance, cash shifts & reconciliation | 🟡 schema ready |
| 7 | Dashboard, reports, CSV/PDF exports | ⏳ |
| 8 | Hardening, load tests, monitoring, deployment & backup runbooks, admin/user docs | ⏳ |
| 2+ | Next.js frontend | ⏳ |
