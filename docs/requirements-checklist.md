# Requirements checklist

Status: ✅ done and tested · 🟡 designed (schema/contract in place), behaviour in a later phase · ⏳ not started · ❌ failing

_Last updated: frontend part 3 (stock and purchasing screens)._

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
| Email delivery for password reset | ✅ | SMTP transport (`MAIL_TRANSPORT=smtp`), `smtp-mail.service.spec.ts`; sent without blocking the response |
| Redis-backed rate limit | ✅ | `RedisThrottlerStorage` when `REDIS_URL` is set (`redis-throttler.storage.spec.ts`; CI runs the e2e suite on Redis). Permissions are read per request from PostgreSQL, no cache needed at measured load ([performance.md](performance.md)) |

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
| Invoice PDF / print | ✅ | Phase 7, `GET /invoices/:id/pdf` (reports e2e) |
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
| Kitchen and POS screens (frontend) | ✅ | `apps/web` POS and kitchen screens; `apps/web/e2e/service.spec.ts` |

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
| Inventory and purchase reports | ✅ | Phase 7, `test/reports.e2e-spec.ts` |
| Inventory screens (frontend) | ✅ | Frontend part 3 below; `apps/web/e2e/stock.spec.ts` |

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
| Receipts private: permission-checked route, signed expiring S3 links | ✅ | `GET /expenses/:id/receipt`, expenses e2e (public `/uploads` refuses receipts) |
| Shift roster (planned shifts) API | 🟡 | Schema ready (`employee_shifts`); API later |
| Split shifts on one day | 🟡 | One attendance span per day; a manager records the total |
| Staff, expense and cash screens (frontend) | ✅ | Frontend part 4 below; `apps/web/e2e/money.spec.ts`, `apps/web/e2e/team.spec.ts` |

## Phase 7 – Dashboard, reports and exports

| Requirement | Status | Evidence |
|---|---|---|
| Dashboard: sales, orders (completed/pending/cancelled), average order value, gross and net revenue, expenses, estimated profit | ✅ | `test/reports.e2e-spec.ts` |
| Dashboard: payment methods, best sellers, low stock, recent transactions, branch performance | ✅ | reports e2e |
| Dashboard filters: today, yesterday, this week, this month, custom | ✅ | reports e2e, `reports.spec.ts` |
| All figures from database records (no stored or typed-in statistics) | ✅ | reports e2e compares with table sums |
| Daily, weekly, monthly and annual sales | ✅ | reports e2e |
| Product-wise and category-wise sales | ✅ | reports e2e |
| GST collected (by rate, HSN/SAC, GSTIN, B2B) | ✅ | reports e2e |
| Discounts, refunds, cancelled orders, payment methods | ✅ | reports e2e |
| Inventory consumption, wastage, supplier purchases, expenses | ✅ | reports e2e |
| Estimated profit (net sales − recipe cost − wastage − expenses) | ✅ | reports e2e |
| Branch performance and employee performance | ✅ | reports e2e |
| Consistent definitions: gross sales, discounts, taxes, refunds, net sales, collected payments | ✅ | [reports.md](reports.md); one shared calculation (`facts.ts`) |
| Reports reconcile: products add up to net sales, ledger opening + movements = closing | ✅ | reports e2e |
| CSV and PDF exports for every report; invoice PDF | ✅ | reports e2e |
| Branch and organization isolation; financial figures hidden without permission | ✅ | reports e2e |
| Report screens (frontend) | 🟡 | Next.js frontend |
| Heavy reports in background jobs / cached | ✅ | Not needed: month reports p95 under 160 ms at 25 concurrent clients ([performance.md](performance.md)) |

## Phase 8 – Hardening, load tests, monitoring, deployment, docs

| Requirement | Status | Evidence |
|---|---|---|
| Security review against the spec's list; documented defences | ✅ | [security.md](security.md) |
| Unsafe production settings refused at startup (CORS, cookies, mail, JWT secret, app URL) | ✅ | `env.spec.ts` |
| Rate limits shared across API instances (Redis), failing open if Redis is down | ✅ | `redis-throttler.storage.spec.ts` |
| Real email delivery (SMTP) | ✅ | `smtp-mail.service.spec.ts` |
| Private expense receipts | ✅ | expenses e2e |
| Monitoring: Prometheus metrics, readiness with DB and Redis, alert rules, runbooks | ✅ | `test/ops.e2e-spec.ts`, `ops/monitoring/`, [monitoring.md](monitoring.md) |
| Error tracking: request ids in every error, structured logs, crash handling | ✅ | `main.ts`, exception filter, [monitoring.md](monitoring.md) |
| End-to-end dine-in flow test (waiter → kitchen → cashier → UPI → reports) | ✅ | `test/critical-flows.e2e-spec.ts` |
| Edge cases: concurrent order edits, double payment, checkout retries, two cashiers one table, branches in parallel | ✅ | critical-flows e2e |
| Load test with recorded p50/p95/p99 | ✅ | `pnpm load-test`, [performance.md](performance.md); smoke run in CI |
| Production deployment with HTTPS | ✅ | `ops/production/`, [deployment.md](deployment.md) |
| First-organization setup for a real install | ✅ | `prisma/create-organization.ts`, ops e2e |
| Backups and tested restore | ✅ | `ops/backup/`, [backup-restore.md](backup-restore.md) (drill run 2026-11-08) |
| Admin and user guides | ✅ | [admin-guide.md](admin-guide.md), [user-guide.md](user-guide.md) |
| Error tracking service (Sentry or similar) | 🟡 | Logs carry everything needed; plugging in a hosted service is a config choice for the operator |

## Later phases

| Phase | Area | Status |
|---|---|---|
| 2+ | Next.js frontend (POS, kitchen display, admin, reports screens) | 🟡 parts 1–3 done (below) |

## Frontend part 1 – Sign-in, POS, kitchen display, tables

| Requirement | Status | Evidence |
|---|---|---|
| Sign-in, forgot and reset password; session restored after reload; token kept in memory only | ✅ | `e2e/service.spec.ts` (sign-in) |
| Navigation shows only the screens the user's role allows; kitchen staff land on the kitchen | ✅ | `src/lib/nav.ts`, sign-in e2e |
| Branch switcher for users in several branches | ✅ | `src/app/(app)/layout.tsx` |
| POS: menu by category with search, veg/non-veg marks, sizes, add-ons, kitchen notes | ✅ | dine-in e2e |
| POS: dine-in (per table), takeaway and delivery (customer and address) | ✅ | dine-in and takeaway e2e |
| All totals and taxes come from the server; the screen never calculates money | ✅ | `src/lib/format.ts` (display only), dine-in e2e checks ₹588.00 |
| Fast taps never race: changes are queued against the latest order version; conflicts reload | ✅ | `src/lib/use-order.ts` |
| Send to kitchen (first KOT and later KOTs); remove sent items with a reason | ✅ | dine-in e2e |
| Bill once (retry-safe), split payments across cash/UPI/card, open cash drawer when needed, print PDF | ✅ | dine-in e2e (₹500 cash + ₹88 UPI) |
| Waiters cannot bill or take payments | ✅ | permissions e2e |
| Kitchen display: New / Cooking / Ready columns, station filter, tap item or ticket, waiting timer with late warning | ✅ | dine-in e2e |
| Live updates on kitchen, POS, tables and orders, with polling fallback and resync after reconnect | ✅ | dine-in e2e (ticket and "Ready" arrive without reload) |
| Table floor: tables at saved positions, colour by state, seat guests, free after payment | ✅ | dine-in and table e2e |
| Orders list with filters, search and paging | ✅ | `src/app/(app)/orders/page.tsx` |
| Works on tablets and phones (responsive layout, large touch targets) | ✅ | layout; checked at 390 px |
| Web container image and production routing (Caddy: app and API on one origin) | ✅ | `apps/web/Dockerfile`, `ops/production/` |
| CI: typecheck, unit tests, browser tests against real API and PostgreSQL, image build | ✅ | `.github/workflows/ci.yml` (web job) |

## Frontend part 2 – Owner and manager screens

| Requirement | Status | Evidence |
|---|---|---|
| Manage area shown only to roles that can use it; each tab checks its own permission | ✅ | `src/lib/nav.ts`, `src/app/(app)/manage/layout.tsx`; kitchen nav e2e |
| Menu: categories (add, rename, hide), dishes with price, GST rate, HSN/SAC, station, veg mark, sizes and add-on groups | ✅ | `e2e/manage.spec.ts` (dish with two sizes sold at POS) |
| Add-on groups and add-ons with prices, min/max choices | ✅ | `src/app/(app)/manage/menu/page.tsx` |
| Prices only editable with `menu.price.update` (owner); managers edit the rest | ✅ | `src/components/product-editor.tsx` (server enforces too) |
| Sold out per branch, also by kitchen staff; POS shows Sold out and blocks it | ✅ | manage e2e (kitchen marks sold out) |
| Staff: add with first password and role (branch or all branches), edit, give/remove roles, deactivate | ✅ | manage e2e (manager adds a waiter who signs in) |
| Branch managers can read roles to assign them, but not change roles | ✅ | `test/rbac.e2e-spec.ts` |
| Table layout: drag or arrow keys on a grid, save together; add, edit, out of service, remove | ✅ | manage e2e (move, save, add table shows on floor) |
| Branches: create (owner), details and GSTIN checks, billing settings, kitchen stations | ✅ | manage e2e (new branch, settings saved, station added) |
| New branches get a valid, unique bill number prefix (codes with "-" no longer block saving settings) | ✅ | `test/rbac.e2e-spec.ts` (new branches) |
| Bill dialog never re-sends the bill request while the first is in flight | ✅ | `src/components/bill-dialog.tsx`; takeaway e2e |

## Frontend part 3 – Stock and purchasing screens

| Requirement | Status | Evidence |
|---|---|---|
| Stock section for storekeepers, managers and owners; storekeepers land on it | ✅ | `src/lib/nav.ts`; `e2e/stock.spec.ts` |
| Ingredients with counting unit (g/ml/pc), category; stop using an ingredient | ✅ | stock e2e |
| Stock per branch with low and below-zero marks, "running low" filter | ✅ | stock e2e (low after setting minimum) |
| Stock count (partial or full) in any matching unit, with cost for the first count | ✅ | stock e2e (10 kg at ₹80/kg) |
| Add or remove stock with a reason, wastage, minimum levels; every change retry-safe (idempotency keys) | ✅ | stock e2e (wastage 500 g) |
| Stock history with every movement and balance after it | ✅ | stock e2e |
| Recipes per dish (and per size), waste %, cost per portion from the server | ✅ | stock e2e (₹8.80 a portion) |
| Suppliers: add, edit, payment terms, GSTIN, inactive | ✅ | stock e2e |
| Purchase orders: create (with "add items running low"), owner approval, cancel with reason, receive part or all, price changes on receipt | ✅ | stock e2e (order, approve, receive, stock 29.5 kg) |
| Deliveries without a purchase order | ✅ | `src/app/(app)/stock/purchases/page.tsx` |
| All money (order totals, GST, stock value, recipe cost) from the server | ✅ | stock e2e checks ₹1,680.00 |
| Branch switcher has an accessible name | ✅ | `src/app/(app)/layout.tsx` |

## Frontend part 4 – Money and team screens

| Requirement | Status | Evidence |
|---|---|---|
| Money section (cash drawer, expenses, supplier bills) and Team section (attendance, employees), each shown only to roles that can use it | ✅ | `src/lib/nav.ts`; money and team e2e |
| Cash drawer: open with counted cash, add or take out cash with a reason, retry-safe (idempotency keys) | ✅ | money e2e (₹1,000 + ₹500 − ₹200 = ₹1,300 from the server) |
| Close a shift with the counted cash; a difference needs a note; short or over shown | ✅ | money e2e (₹50.00 short refused without a note, then closed) |
| Managers see every shift, each shift's report and entries, cash by cashier, and can close another person's shift | ✅ | money e2e (manager sees the short shift and its entries) |
| Expenses by month and category with the server's totals and GST; receipt photo or PDF upload and viewing | ✅ | money e2e (₹1,180 with a PNG receipt) |
| Expense edits need a reason and keep a history; delete (owner) needs a reason; paid-from-drawer option | ✅ | money e2e (accountant corrects to ₹1,080) |
| Expense categories: add, stop using, use again | ✅ | `src/app/(app)/money/expenses/page.tsx` |
| Supplier bills: enter a bill (with the deliveries it covers), due date from payment terms, pay in parts, cancel with a reason, overdue filter | ✅ | money e2e (₹4,200 bill, ₹1,500 paid, ₹2,700 owed) |
| Supplier statement with running balance | ✅ | money e2e (owed now ₹2,700.00) |
| Employees: add, edit, job, joining date, salary (only for people who manage staff), branch, tie to a sign-in, mark as left | ✅ | team e2e |
| Clock in and out from the top bar, for staff with an employee record | ✅ | team e2e (waiter clocks in and out) |
| Attendance by day with the month's summary; managers record or correct a day (leave, absent, half day, times) with a reason | ✅ | team e2e (leave recorded) |
| Receipt uploads send multipart form data | ✅ | `src/lib/api.test.ts` |
