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
| Money | Decimal strings in JSON, never floats. Values are exact but not zero-padded (`"945"`, `"945.5"`, `"2.5"` for rates); format for display on the client. Requests send amounts as strings with up to 2 decimals (`"945.50"`). Clients send quantities and choices, never totals. |
| Idempotency (Phase 3+) | `Idempotency-Key: <uuid>` required on order submission, checkout, invoice creation, payments and refunds. Same key + same body replays the stored response; same key + different body returns `409 IDEMPOTENCY_KEY_REUSED`. |
| Concurrency | Mutable aggregates (tables now, orders in Phase 3) return `version`; updates may send it back and get `409 CONCURRENT_UPDATE` if someone else changed the record first. Table operations also take row locks, so simultaneous operations on one table are serialised. |
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

## Implemented in Phase 2

Menu data is organization-wide; prices and availability can be overridden per branch.
"org" scope means the permission must be held organization-wide; "any" means in at least one branch.

| Method | Path | Permission (scope) | Notes |
|---|---|---|---|
| GET | /tax-rates | `menu.read` (any) | `?includeInactive=true` |
| POST | /tax-rates | `taxes.manage` (org) | `{ name, rate, cessRate?, effectiveFrom? }`; CGST = SGST = rate/2 and IGST = rate are derived |
| PATCH | /tax-rates/:id | `taxes.manage` (org) | `name`, `isActive`, `effectiveTo` only; rates are immutable (create a new rate instead) |
| GET/POST | /branches/:branchId/kitchen-stations | `menu.read` / `menu.manage` (branch) | `{ code, name }`; `code` matches `product.stationCode` |
| PATCH | /branches/:branchId/kitchen-stations/:id | `menu.manage` (branch) | |
| GET | /menu?branchId= | `menu.read` (branch) | POS menu: active categories and products with branch price and availability resolved, variants, add-on groups, combo contents, tax rate, `taxPricingMode` |
| GET | /menu/categories, /menu/categories/:id | `menu.read` (any) | With product counts |
| POST / PATCH | /menu/categories[/:id] | `menu.manage` (org) | `{ name, parentId?, sortOrder?, isActive? }`; parent loops rejected |
| DELETE | /menu/categories/:id | `menu.manage` (org) | Soft delete; `409 CATEGORY_NOT_EMPTY` while it has products or sub-categories |
| GET | /menu/modifier-groups[/:id] | `menu.read` (any) | Add-on groups with add-ons |
| POST | /menu/modifier-groups | `menu.manage` (org) | `{ name, minSelect, maxSelect, modifiers: [{ name, price }] }` |
| PATCH | /menu/modifier-groups/:id | `menu.manage` (org) | |
| POST | /menu/modifier-groups/:id/modifiers | `menu.manage` (org) | |
| PATCH | /menu/modifier-groups/:id/modifiers/:modifierId | `menu.manage` (org); price change also `menu.price.update` (org) | Deactivate with `isActive: false` |
| GET | /menu/products | `menu.read` (any) | Paginated; `categoryId`, `isActive`, `search` (name or SKU) |
| GET | /menu/products/:id | `menu.read` (any) | Variants, add-on groups, combo items, tax rate |
| POST | /menu/products | `menu.manage` + `menu.price.update` (org) | `{ categoryId, sku, name, basePrice, taxRateId?, hsnSac?, isVeg?, stationCode?, isCombo?, variants?, modifierGroupIds?, comboItems? }`; first variant is the default unless one is marked |
| PATCH | /menu/products/:id | `menu.manage` (org); `basePrice` change also `menu.price.update` (org) | Audited as `product.price_changed` |
| DELETE | /menu/products/:id | `menu.manage` (org) | Soft delete; `409 PRODUCT_IN_COMBO` while a combo contains it |
| POST | /menu/products/:id/variants | `menu.manage` + `menu.price.update` (org) | |
| PATCH | /menu/products/:id/variants/:variantId | `menu.manage` (org); price change also `menu.price.update` | One default per product (enforced in the DB) |
| PUT | /menu/products/:id/modifier-groups | `menu.manage` (org) | `{ groupIds }`, order = display order |
| PUT | /menu/products/:id/combo-items | `menu.manage` (org) | `{ items: [{ productId, variantId?, quantity }] }`; combos only, no nesting |
| GET | /menu/products/:id/branch-prices?branchId= | `menu.read` (branch) | |
| PUT | /menu/products/:id/branch-prices | `menu.availability.update` (branch); changing any price also `menu.price.update` (branch) | `{ branchId, overrides: [{ variantId\|null, price\|null, isAvailable }] }` replaces the branch's overrides; `price: null` keeps the menu price |
| PATCH | /menu/products/:id/availability | `menu.availability.update` (branch with `branchId`, org without) | `{ branchId?, isAvailable }` – "86" an item in one branch or everywhere |
| POST | /menu/products/:id/image | `menu.manage` (org) | `multipart/form-data`, field `image`; JPEG/PNG/WebP by content (not name), max `UPLOAD_MAX_IMAGE_BYTES` (2 MB) → `413`; others → `422 UNSUPPORTED_IMAGE` |
| GET | /branches/:branchId/tables[/:id] | `tables.read` (branch) | Floor plan with live status, `version`, open `session` (guests, merged tables), `reservationExpired` |
| POST | /branches/:branchId/tables | `tables.manage` (branch) | `{ label, capacity, area?, shape?: RECT\|ROUND, posX?, posY?, width?, height? }` |
| PATCH | /branches/:branchId/tables/:id | `tables.manage` (branch) | Optional `version` → `409 CONCURRENT_UPDATE` when stale |
| PUT | /branches/:branchId/tables/layout | `tables.manage` (branch) | `{ tables: [{ id, posX, posY, width?, height?, shape?, area? }] }`, all-or-nothing |
| DELETE | /branches/:branchId/tables/:id | `tables.manage` (branch) | Soft delete; `409 TABLE_IN_USE` while open |
| POST | /branches/:branchId/tables/:id/open | `tables.operate` (branch) | `{ guestCount }`; from AVAILABLE or RESERVED (clears the reservation) |
| POST | /branches/:branchId/tables/:id/close | `tables.operate` (branch) | Closes the session and all tables merged into it; `409 TABLE_HAS_OPEN_ORDERS` until every order is completed or cancelled |
| POST | /branches/:branchId/tables/:id/transfer | `tables.operate` (branch) | `{ toTableId }` (must be AVAILABLE); session and orders move |
| POST | /branches/:branchId/tables/:id/merge | `tables.operate` (branch) | `{ tableIds }` (occupied tables); their orders move to this table's session |
| POST | /branches/:branchId/tables/:id/split | `tables.operate` (branch) | Detaches a merged table; moved orders stay on the main table |
| POST | /branches/:branchId/tables/:id/reserve | `tables.operate` (branch) | `{ name, phone?, until }` (future time) |
| DELETE | /branches/:branchId/tables/:id/reservation | `tables.operate` (branch) | |
| PATCH | /branches/:branchId/tables/:id/service-status | `tables.manage` (branch) | `{ outOfService }` |

Phase 2 error codes: `INVALID_CATEGORY`, `INVALID_PARENT`, `CATEGORY_NOT_EMPTY`, `INVALID_TAX_RATE`,
`INVALID_MODIFIER_GROUP`, `INVALID_SELECTION_RANGE`, `DUPLICATE_NAME`, `INVALID_DEFAULT`, `NOT_A_COMBO`,
`INVALID_COMBO_ITEM`, `PRODUCT_IN_COMBO`, `INVALID_VARIANT`, `DUPLICATE_OVERRIDE`, `FILE_REQUIRED`,
`UNSUPPORTED_IMAGE`, `TABLE_NOT_AVAILABLE`, `TABLE_NOT_OCCUPIED`, `TABLE_INACTIVE`, `TABLE_IN_USE`,
`TABLE_MERGED`, `TABLE_HAS_MERGES`, `TABLE_NOT_MERGED`, `TABLE_HAS_OPEN_ORDERS`, `TABLE_NOT_RESERVED`,
`TABLE_NOT_OUT_OF_SERVICE`, `SAME_TABLE`, `DUPLICATE_TABLE`, `INVALID_RESERVATION_TIME`, `CONCURRENT_UPDATE`.

## Planned contracts (later phases)

These fix names and shapes now so the frontend and backend can be built against them. Details
may be refined in each phase's PR.

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
