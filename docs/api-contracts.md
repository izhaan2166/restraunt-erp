# RestaurantOS – API contracts

Base URL `/api/v1`. Interactive docs: `GET /api/docs` (Swagger UI, on by default outside
production); machine-readable spec: [`openapi.json`](./openapi.json) (`GET /api/docs-json`).

## Conventions

| Topic | Contract |
|---|---|
| Auth | `Authorization: Bearer <access token>`. Browsers also hold the refresh token in the `ros_rt` httpOnly cookie. |
| Branch context | Branch-scoped calls name the branch by path `:branchId`, `?branchId=`, body `branchId`, or header `X-Branch-Id`. Unknown and other-tenant branches return 404. |
| Success | `200/201` with `{ "data": … }`; lists `{ "data": [...], "meta": { page, pageSize, total, totalPages } }`; `204` with no body. |
| Errors | `{ "error": { "code": "MISSING_PERMISSION", "message": "…", "details": {…}, "requestId": "…" } }` |
| Status codes | 400 validation / business rule, 401 not signed in, 403 signed in but not allowed, 404 not found or not yours, 409 conflict (duplicate, concurrent change, idempotency mismatch), 422 state rule (e.g. invalid order transition), 423 account locked, 429 rate limited. |
| Validation | Unknown fields are rejected (`VALIDATION_FAILED`, details list each problem). |
| Pagination | `?page=1&pageSize=25` (max 100), `?order=asc|desc`, `?search=`. Module-specific filters are documented per endpoint. |
| Money | Decimal strings in JSON (`"945.00"`), never floats. Clients send quantities and choices, never totals. |
| Idempotency (Phase 3+) | `Idempotency-Key: <uuid>` required on order submission, checkout, invoice creation, payments and refunds. Same key + same body replays the stored response; same key + different body returns `409 IDEMPOTENCY_KEY_REUSED`. |
| Concurrency (Phase 3+) | Mutable aggregates (orders, tables) return `version`; updates send it back and get `409 CONCURRENT_UPDATE` if someone else changed the record first. |
| Tracing | Send `X-Request-Id` to correlate; every error carries `requestId`. |

## Error codes (Phase 1)

`VALIDATION_FAILED`, `UNAUTHENTICATED`, `INVALID_CREDENTIALS`, `ACCOUNT_LOCKED`,
`INVALID_ACCESS_TOKEN`, `SESSION_INVALID`, `REFRESH_TOKEN_MISSING`, `INVALID_REFRESH_TOKEN`,
`REFRESH_TOKEN_REUSED`, `ORIGIN_NOT_ALLOWED`, `WEAK_PASSWORD`, `INVALID_RESET_TOKEN`,
`INVALID_CURRENT_PASSWORD`, `MISSING_PERMISSION`, `ROUTE_NOT_AUTHORIZED`, `BRANCH_REQUIRED`,
`INVALID_BRANCH_ID`, `PRIVILEGE_ESCALATION`, `ROLE_IMMUTABLE`, `ROLE_IN_USE`,
`ROLE_ALREADY_ASSIGNED`, `UNKNOWN_PERMISSION`, `LAST_SUPER_ADMIN`, `EMAIL_TAKEN`,
`CANNOT_DEACTIVATE_SELF`, `SUPER_ADMIN_ORG_WIDE`, `UNIQUE_VIOLATION`, `REFERENCE_VIOLATION`,
`NOT_FOUND`, `RATE_LIMITED`, `INTERNAL_ERROR`.

## Implemented in Phase 1

| Method | Path | Permission (scope) | Notes |
|---|---|---|---|
| POST | /auth/login | public, auth rate limit | `{ email, password }` → `{ accessToken, expiresIn, refreshToken, refreshExpiresAt }` + cookie |
| POST | /auth/refresh | public, auth rate limit | Body `refreshToken` or cookie. Rotates; reuse revokes the session |
| POST | /auth/logout | public | Ends the session identified by the refresh token/cookie → 204 |
| POST | /auth/logout-all | signed in | Ends every session of the user → 204 |
| POST | /auth/forgot-password | public, auth rate limit | Always 202 with the same message |
| POST | /auth/reset-password | public, auth rate limit | `{ token, newPassword }` → 204, signs out everywhere |
| POST | /auth/change-password | signed in | `{ currentPassword, newPassword }` → 204, signs out other sessions |
| GET | /auth/me | signed in | User, organization, role assignments, branches, permissions org-wide and per branch |
| GET | /organization | `organization.read` (org) | |
| PATCH | /organization | `organization.update` (org) | GSTIN/PAN/state code validated |
| GET | /branches | signed in | Branches the caller can access |
| GET | /branches/:branchId | `branches.read` (branch) | Includes branch settings |
| POST | /branches | `branches.create` (org) | Creates default branch settings |
| PATCH | /branches/:branchId | `branches.update` (branch) | |
| GET | /users | `users.read` (org, or branch with `?branchId`) | Filters: `isActive`, `search` |
| GET | /users/:id | `users.read` (any) | 404 when outside the caller's branches |
| POST | /users | `users.create` + `users.assign_roles` (each assignment's scope) | `{ email, fullName, phone?, password, roles: [{ roleId, branchId\|null }] }` |
| PATCH | /users/:id | `users.update`; `users.deactivate` to change `isActive` | Deactivation revokes all sessions |
| POST | /users/:id/roles | `users.assign_roles` (target scope) | Anti-escalation enforced |
| DELETE | /users/:id/roles/:assignmentId | `users.assign_roles` (assignment scope) | Last Super Admin protected |
| GET | /permissions | `roles.read` (org) | Catalog |
| GET | /roles, /roles/:id | `roles.read` (org) | With permissions and assigned-user counts |
| POST | /roles | `roles.manage` (org) | Custom role; only permissions you hold |
| PUT | /roles/:id/permissions | `roles.manage` (org) | Replace set; not allowed for SUPER_ADMIN |
| DELETE | /roles/:id | `roles.manage` (org) | Custom roles without assignments only |
| GET | /audit-logs | `audit.read` (org, or branch) | Filters: actor, entity, action, date range |
| GET | /health/live, /health/ready | public | Readiness checks PostgreSQL |

## Planned contracts (later phases)

These fix names and shapes now so the frontend and backend can be built against them. Details
may be refined in each phase's PR.

### Phase 2 – Menu and tables
```
GET    /menu?branchId=                     categories → products → variants/add-ons with branch prices
POST   /menu/categories            PATCH /menu/categories/:id        DELETE /menu/categories/:id
POST   /menu/products              PATCH /menu/products/:id          DELETE /menu/products/:id (soft)
PUT    /menu/products/:id/branch-prices    menu.price.update
PATCH  /menu/products/:id/availability     { branchId, isAvailable }
POST   /menu/modifier-groups ...
GET    /branches/:branchId/tables          floor plan with live status
POST   /branches/:branchId/tables  PATCH /tables/:id
POST   /tables/:id/open  /tables/:id/transfer  /tables/merge  /tables/:id/split
```

### Phase 3 – Orders, billing, payments
```
GET    /orders?branchId=&status=&type=&from=&to=
POST   /orders                     Idempotency-Key. { branchId, orderType, tableId?, items: [{ productId, variantId?, quantity, modifiers[], instructions? }] }
GET    /orders/:id
PATCH  /orders/:id                 { version, addItems[], removeItemIds[], updateItems[] }
POST   /orders/:id/confirm         NEW → CONFIRMED, creates KOTs
POST   /orders/:id/cancel          { reason }   orders.cancel
POST   /orders/:id/reopen          { reason }   orders.reopen
POST   /orders/:id/discounts       { scope, type, value, orderItemId?, reason }  billing.discount.apply / .override
POST   /billing/checkout           Idempotency-Key. { orderId, buyerGstin?, payments: [{ method, amount, reference? }] } → invoice + payments in one transaction
POST   /invoices                   Idempotency-Key. { orderId }
GET    /invoices/:id               GET /invoices/:id/pdf
POST   /invoices/:id/finalize
POST   /invoices/:id/payments      Idempotency-Key. { method, amount, reference? }  amount ≤ outstanding
POST   /invoices/:id/refunds       Idempotency-Key. { paymentId, amount, reason, restock }  refunds.create (+ approval)
POST   /invoices/:id/credit-notes  { lines[], reason }
```
Order state machine (server-enforced): `NEW → CONFIRMED → PREPARING → READY → SERVED → COMPLETED`;
takeaway `READY → PICKED_UP → COMPLETED`; delivery `READY → OUT_FOR_DELIVERY → DELIVERED → COMPLETED`;
`CANCELLED` from any non-final state with a reason; reopen only with `orders.reopen`.

### Phase 4 – Kitchen and realtime
```
GET    /kot?branchId=&stationId=&status=
PATCH  /kot/items/:id/status       { status: PREPARING|READY|SERVED }
WS     /realtime                   auth: access token; join room org:{id}:branch:{id}
events order.created order.updated order.cancelled kot.created kot.item.updated
       table.status.updated payment.completed inventory.low_stock shift.closed
```

### Phase 5 – Inventory and purchasing
```
GET    /inventory?branchId=        GET /inventory/low-stock      GET /inventory/movements
POST   /inventory/adjustments      POST /inventory/wastage
PUT    /recipes/:productId         { items: [{ ingredientId, quantity, unitId, wastagePercent }] }
CRUD   /suppliers
POST   /purchase-orders            POST /purchase-orders/:id/approve
POST   /purchase-orders/:id/receipts   partial deliveries → stock movements
POST   /supplier-invoices          POST /supplier-payments (Idempotency-Key)
```

### Phase 6 – Expenses, employees, shifts
```
CRUD   /expenses  /expense-categories        receipts via signed upload URL
CRUD   /employees    POST /attendance/clock-in  /attendance/clock-out
POST   /cash-sessions/open   POST /cash-sessions/:id/movements   POST /cash-sessions/:id/close { actualCash, notes }
GET    /cash-sessions/:id/report
```

### Phase 7 – Dashboard and reports
```
GET /dashboard?branchId=&range=today|yesterday|this_week|this_month|custom&from=&to=
GET /reports/sales  /reports/products  /reports/categories  /reports/gst  /reports/discounts
GET /reports/refunds  /reports/cancellations  /reports/payments  /reports/inventory
GET /reports/wastage  /reports/purchases  /reports/expenses  /reports/profit-loss
GET /reports/branches  /reports/employees            ?format=csv|pdf for exports
```
Report definitions: gross sales = Σ line subtotals; discounts; net sales = gross − discounts;
tax collected = CGST + SGST + IGST; refunds by credit note date; collected payments = Σ completed
payments − refunds; estimated profit = net sales − COGS (recipe cost) − expenses.
