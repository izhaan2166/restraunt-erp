# Requirements checklist

Status: ✅ done and tested · 🟡 designed (schema/contract in place), behaviour in a later phase · ⏳ not started · ❌ failing

_Last updated: Phase 6._

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
| Redis-backed rate limit / permission cache | 🟡 | In-memory throttler for now; Redis in Phase 8 (realtime fan-out uses PostgreSQL, see architecture §9) |

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
| `BILL_PENDING` table status | ✅ | Set by invoicing in Phase 3 (billing e2e) |
| Real-time floor plan updates | ✅ | `table.status.updated` events (Phase 4, realtime e2e) |

## Phase 3 – POS, orders, billing and GST invoices

| Requirement | Status | Evidence |
|---|---|---|
| Dine-in, takeaway and delivery orders with variants, add-ons and notes | ✅ | `test/orders.e2e-spec.ts` |
| Order state machine enforced by the server (per order type) | ✅ | `order-state.spec.ts`, orders e2e |
| KOT per kitchen station on confirm; later additions sent as new KOTs | ✅ | orders e2e |
| Items sent to the kitchen cannot be silently edited; removal needs `orders.cancel` + reason | ✅ | orders e2e |
| Cancel and reopen with reason and permission | ✅ | orders e2e |
| Item and order discounts (percentage/fixed) with reason; cashier limit, override permission | ✅ | orders e2e, `engine.spec.ts` |
| Price override only with permission and reason | ✅ | orders e2e |
| Billing engine with decimal math: CGST/SGST (intra-state), IGST, inclusive/exclusive pricing, service charge, round-off | ✅ | `engine.spec.ts` (incl. 500 random bills), billing e2e |
| GST invoice with seller/buyer GSTIN, HSN/SAC, tax summary per rate | ✅ | billing e2e |
| Consecutive invoice numbers per branch per financial year, no gaps from failed requests | ✅ | `sequences.spec.ts`, billing e2e |
| Finalized invoices immutable (DB triggers); corrections via credit notes | ✅ | billing e2e |
| Split and partial payments (cash, card, UPI, wallet…); overpayment refused | ✅ | billing e2e |
| Refunds against the original payment, with manager approval when needed (no self-approval) | ✅ | billing e2e |
| Credit notes per line with tax reversal; invoice cancellation | ✅ | billing e2e |
| Idempotency on order submission, checkout, invoice, payment and refund (incl. simultaneous retries) | ✅ | orders & billing e2e |
| Concurrency: one payment wins when several race for the same balance; stale order versions refused | ✅ | billing e2e (5 parallel payments), orders e2e |
| Table becomes BILL_PENDING while money is owed and OCCUPIED once paid | ✅ | billing e2e |
| Audit log for invoices, payments, refunds, credit notes, discounts, cancels | ✅ | services write `audit_logs`; e2e checks |
| Orders and invoices isolated per organization/branch | ✅ | orders & billing e2e |
| Invoice PDF / print | 🟡 | Phase 7 (reports and exports) |
| Cash payments tied to a cash shift | ✅ | Phase 6, `test/cash.e2e-spec.ts` |
| Stock deduction on sale and restock on refund | ✅ | Phase 5, `test/inventory.e2e-spec.ts` |
| Live order updates to POS and kitchen screens | ✅ | Phase 4 realtime events |

## Phase 4 – Kitchen display and realtime

| Requirement | Status | Evidence |
|---|---|---|
| Confirmed orders reach the kitchen as KOTs, one per station (Main, Beverages, Desserts…) | ✅ | `test/kitchen.e2e-spec.ts` |
| KDS shows table, order number, items, quantities, add-ons, instructions, elapsed time | ✅ | kitchen e2e |
| Station filter; live board vs. finished tickets; `updatedSince` resync | ✅ | kitchen e2e |
| Mark items preparing / ready (kitchen), served (kitchen or floor staff); forward only | ✅ | kitchen e2e, `kitchen-state.spec.ts` |
| One ready item does not make the order ready; order follows its slowest item | ✅ | `kitchen-state.spec.ts`, kitchen e2e |
| Items added later go out as a new ticket; removed or cancelled items leave the screen | ✅ | kitchen e2e |
| Simultaneous kitchen taps on one order are serialized (order row lock) | ✅ | kitchen e2e (5 parallel taps → READY once) |
| Who changed each item is recorded (item + audit log) | ✅ | kitchen e2e |
| WebSocket connections authenticated (token + live session) | ✅ | `test/realtime.e2e-spec.ts` |
| Branch and topic authorization for channels | ✅ | realtime e2e |
| Events: order.created/updated/cancelled, kot.created/updated/item.updated, table.status.updated, payment.completed, refunds | ✅ | realtime e2e |
| Events written in the same transaction as the change (outbox); rolled-back changes send nothing | ✅ | realtime e2e |
| Duplicate-safe: unique increasing event ids; repeated changes in one request merged | ✅ | realtime e2e |
| Safe reconnect: replay on subscribe or `GET /realtime/events`; `RESYNC_REQUIRED` beyond retention | ✅ | realtime e2e |
| Several API instances: gap-free numbering, every instance delivers | ✅ | realtime e2e (two app instances) |
| PostgreSQL stays the source of truth (events are notifications; details via REST) | ✅ | design, `docs/architecture.md` §9 |
| `inventory.low_stock` event | ✅ | Phase 5 inventory e2e |
| `shift.closed` event | ✅ | Phase 6 cash e2e |
| Kitchen and POS screens (frontend) | 🟡 | Next.js frontend |

## Phase 5 – Inventory, recipes, suppliers and purchasing

| Requirement | Status | Evidence |
|---|---|---|
| Ingredients with a base unit (g, ml, pc); kg/l/dozen converted, mixing kinds refused | ✅ | `units.spec.ts`, `test/inventory.e2e-spec.ts` |
| Stock per branch; append-only stock ledger with balance after each movement | ✅ | inventory e2e (ledger update/delete refused by the DB) |
| Opening stock and physical counts (difference booked) | ✅ | inventory e2e |
| Manual adjustments and wastage with reasons; cannot go below zero | ✅ | inventory e2e |
| Weighted average cost; stock value | ✅ | `units.spec.ts`, purchasing e2e |
| Recipes / BOM per product and per size, with wastage % and yield; cost per portion | ✅ | inventory e2e |
| Sales deduct ingredients on order completion (default) or when sent to the kitchen | ✅ | inventory e2e |
| Deduction happens exactly once; reopen/void reverses it; food already cooking stays used | ✅ | inventory e2e |
| Combos deduct their components' recipes | ✅ | `stock.ts` (`usageFor`); no e2e test yet |
| Refund with restock returns the credited items' ingredients | ✅ | inventory e2e |
| Branch can forbid negative stock (blocks sending to the kitchen) | ✅ | inventory e2e |
| Minimum levels, low-stock list, realtime `inventory.low_stock` / `inventory.restocked`, notification | ✅ | inventory e2e |
| Concurrent stock changes serialized (balance row lock) | ✅ | inventory e2e (8 parallel) |
| Suppliers with GSTIN, payment terms, outstanding and overdue amounts, account statement | ✅ | `test/purchasing.e2e-spec.ts` |
| Purchase orders: draft, edit, approve, cancel, server-side totals, numbering | ✅ | purchasing e2e |
| Goods receipts with partial deliveries; over-receipt refused; receipts without an order | ✅ | purchasing e2e |
| Supplier invoices linked to deliveries; duplicates refused; due date from terms | ✅ | purchasing e2e |
| Supplier payments: partial, never above outstanding, idempotent, concurrency-safe | ✅ | purchasing e2e |
| Branch settings API (stock deduction policy, negative stock, tax mode, prefix) | ✅ | inventory e2e |
| Audit log for every inventory and purchasing change | ✅ | services write `audit_logs`; purchasing e2e |
| Isolation per organization and branch | ✅ | inventory & purchasing e2e |
| Stock transfers between branches | 🟡 | Schema ready (TRANSFER_IN/OUT); API later |
| Inventory and purchase reports | 🟡 | Phase 7 |
| Inventory screens (frontend) | 🟡 | Next.js frontend |

## Phase 6 – Expenses, employees, attendance and cash shifts

| Requirement | Status | Evidence |
|---|---|---|
| Open a shift with an opening balance; one open drawer per cashier | ✅ | `test/cash.e2e-spec.ts` (parallel opens → one wins) |
| Cash additions and withdrawals with reasons; drawer cannot go below zero | ✅ | cash e2e |
| Cash sales and cash refunds flow into the right drawer automatically | ✅ | cash e2e, billing e2e |
| Cash payments need an open shift (branch setting can turn this off) | ✅ | cash e2e |
| Close with counted cash: expected vs actual, discrepancy, note required for a difference | ✅ | cash e2e |
| A closed shift can never be changed (database trigger); movements are append-only | ✅ | cash e2e |
| Shift report (cash breakdown, payments and refunds by method) and employee-wise summary | ✅ | cash e2e |
| Realtime `shift.opened` / `shift.closed`; notification for shortage or overage | ✅ | cash e2e |
| Daily expenses with categories, GST, payment methods, paid-to, employee expenses | ✅ | `test/expenses.e2e-spec.ts` |
| Expenses paid from the cash drawer (and corrected or returned when edited/deleted) | ✅ | expenses e2e |
| Receipt uploads (PDF or image, content checked) | ✅ | expenses e2e |
| Only authorized users edit or delete; reason required; full change history kept | ✅ | expenses e2e |
| Expense report by category and payment method | ✅ | expenses e2e |
| Employee profiles linked to login accounts, roles and branches; salary hidden from non-managers | ✅ | `test/employees.e2e-spec.ts` |
| Clock in / clock out once a day (also past midnight); parallel clock-ins record one | ✅ | employees e2e |
| Forgotten clock-outs caught; managers record absent, leave, half day or correct times, audited | ✅ | employees e2e |
| Attendance and hours report per employee | ✅ | employees e2e |
| Employee activity: login/logout times and recent actions | ✅ | employees e2e |
| Isolation per organization and branch | ✅ | all three suites |
| Receipts behind signed, expiring links | 🟡 | Stored under unguessable names for now; signed URLs in Phase 8 |
| Shift roster (planned shifts) API | 🟡 | Schema ready (`employee_shifts`); API later |
| Split shifts on one day | 🟡 | One attendance span per day; a manager records the total |
| Staff, expense and cash screens (frontend) | 🟡 | Next.js frontend |

## Later phases

| Phase | Area | Status |
|---|---|---|
| 7 | Dashboard, reports, CSV/PDF exports | ⏳ |
| 8 | Hardening, load tests, monitoring, deployment & backup runbooks, admin/user docs | ⏳ |
| 2+ | Next.js frontend | ⏳ |
