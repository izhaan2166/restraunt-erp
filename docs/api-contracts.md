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
| Idempotency | `Idempotency-Key: <uuid>` required on order submission, checkout, invoice creation, payments and refunds. Same key + same body replays the stored response; same key + different body returns `409 IDEMPOTENCY_KEY_REUSED`. |
| Concurrency | Mutable aggregates (tables, orders) return `version`; updates may send it back and get `409 CONCURRENT_UPDATE` if someone else changed the record first. Table operations also take row locks, so simultaneous operations on one table are serialised. |
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

## Implemented in Phase 3

Money values are decimal strings computed by the server (`docs/billing.md`). Routes that address a
record by id check the caller's role in that record's branch: `404` without any role there, `403`
without the permission. Routes marked **Idem.** require an `Idempotency-Key` header (8–100 characters: letters, digits, `_`, `-`; a UUID is ideal);
a replay returns the stored response with `Idempotent-Replayed: true`.

| Method | Path | Permission (scope) | Notes |
|---|---|---|---|
| GET | /orders | `orders.read` (branch) | `branchId`, `status` (comma-separated), `type`, `from`, `to`, `tableSessionId`; paginated |
| POST | /orders | `orders.create` (branch) **Idem.** | `{ branchId, orderType, tableId?, customerName?, customerPhone?, deliveryAddress?, guestCount?, notes?, items: [{ productId, variantId?, quantity, modifiers?: [{ modifierId }], instructions?, unitPriceOverride?, overrideReason? }] }`. Dine-in needs an open table; delivery needs an address. Price override needs `billing.price.override` and a reason |
| GET | /orders/:id | `orders.read` | Items, modifiers, discounts, KOTs, totals, `version`, `allowedTransitions` |
| PATCH | /orders/:id | `orders.update` | `{ version, addItems?, updateItems?: [{ id, quantity }], removeItems?: [{ id, reason? }], customer fields }`. Editable from NEW to SERVED until invoiced; items already sent to the kitchen can only be removed (needs `orders.cancel` and a reason) |
| POST | /orders/:id/confirm | `orders.update` | NEW → CONFIRMED; creates one KOT per kitchen station |
| POST | /orders/:id/kot | `orders.update` | Sends items added later to the kitchen as new KOTs |
| POST | /orders/:id/status | `orders.update` | `{ status, version? }`; state machine below. COMPLETED needs a fully paid invoice |
| POST | /orders/:id/cancel | `orders.cancel` | `{ reason }`; not once invoiced (cancel the invoice first) |
| POST | /orders/:id/reopen | `orders.reopen` | `{ reason }`; restores the items the cancel removed |
| POST | /orders/:id/discounts | `billing.discount.apply`; over the branch cashier limit also `billing.discount.override` | `{ scope: ORDER\|ITEM, type: PERCENTAGE\|FIXED, value, orderItemId?, reason, version }` |
| DELETE | /orders/:id/discounts/:discountId?version= | `billing.discount.apply` | |
| POST | /billing/checkout | `billing.checkout` **Idem.** | `{ orderId, buyerName?, buyerGstin?, payments: [{ method, amount, reference? }] }` → final GST invoice and payments in one transaction (reuses the order's invoice if it already has one) |
| GET | /invoices | `invoices.read` (branch) | `branchId`, `status`, `from`, `to`; paginated |
| POST | /invoices | `invoices.create` **Idem.** | `{ orderId, buyerName?, buyerGstin? }` → issues the final invoice without payment (dine-in table becomes BILL_PENDING) |
| GET | /invoices/:id | `invoices.read` | Lines, tax summary by rate, payments, refunds, credit notes, `due`, `netPaid`, `outstanding`, `refundDue` |
| POST | /invoices/:id/payments | `payments.create` **Idem.** | `{ method, amount, reference? }`; amount ≤ outstanding |
| POST | /invoices/:id/refunds | `refunds.create` **Idem.** | `{ paymentId, amount, reason, method?, creditNoteId?, restock? }` (`restock` is recorded now and applied to stock in Phase 5). Without `refunds.approve` the refund is PENDING until a manager approves it |
| GET | /refunds | `payments.read` (branch) | `branchId`, `status` |
| POST | /refunds/:id/approve, /refunds/:id/reject | `refunds.approve` | Reject takes `{ reason }`; you cannot approve your own refund |
| POST | /invoices/:id/credit-notes | `credit_notes.create` | `{ reason, lines: [{ invoiceItemId, quantity }] }`; tax is reversed line by line |
| POST | /invoices/:id/cancel | `credit_notes.create` | `{ reason }`; only while nothing is paid (refund first). Credits everything still uncredited and lets the order be billed again |

Invoices are issued final in one step (number, seller snapshot, lines, GST), so there is no separate
finalize endpoint. Once final, an invoice cannot be edited (database triggers); corrections are made
with credit notes. Invoice PDF arrives with reports in Phase 7.

Order state machine (server-enforced): `NEW → CONFIRMED → PREPARING → READY → SERVED → COMPLETED`;
takeaway `READY → PICKED_UP → COMPLETED`; delivery `READY → OUT_FOR_DELIVERY → DELIVERED → COMPLETED`.
Steps can be skipped forward (e.g. CONFIRMED → SERVED). `CANCELLED` via `/cancel` only. An order that
is already fully paid completes by itself when it reaches its last step (served, picked up or delivered).

Numbering: orders `YYYYMMDD-0001` and KOTs `KYYYYMMDD-0001` per branch per day (IST); invoices
`<prefix>/<FY>/<n>` (e.g. `MAIN/2627/1`) and credit notes `<prefix>-CN/<FY>/<n>`, consecutive per
branch per financial year (April–March).

Phase 3 error codes: `IDEMPOTENCY_KEY_REQUIRED`, `INVALID_IDEMPOTENCY_KEY`, `IDEMPOTENCY_KEY_REUSED`,
`IDEMPOTENCY_IN_PROGRESS`, `TABLE_REQUIRED`, `TABLE_NOT_ALLOWED`, `TABLE_NOT_OPEN`, `TABLE_CLOSED`,
`DELIVERY_ADDRESS_REQUIRED`, `INVALID_PRODUCT`, `VARIANT_REQUIRED`, `INVALID_VARIANT`, `ITEM_UNAVAILABLE`,
`INVALID_MODIFIER`, `DUPLICATE_MODIFIER`, `INVALID_MODIFIER_SELECTION`, `REASON_REQUIRED`, `INVALID_ORDER_ITEM`,
`ORDER_ITEM_REQUIRED`, `INVALID_QUANTITY`, `ORDER_EMPTY`, `ORDER_NOT_EDITABLE`, `ORDER_INVOICED`,
`ORDER_CANCELLED`, `ITEM_SENT_TO_KITCHEN`, `NOTHING_TO_SEND`, `INVALID_TRANSITION`, `USE_CANCEL`,
`USE_CONFIRM`, `ORDER_NOT_BILLED`, `ORDER_NOT_PAID`, `INVALID_DISCOUNT`, `DISCOUNT_LIMIT_EXCEEDED`,
`ALREADY_INVOICED`, `INVOICE_NOT_FINAL`, `INVOICE_NOT_PAYABLE`, `INVALID_AMOUNT`, `INVALID_PAYMENT`,
`AMOUNT_EXCEEDS_OUTSTANDING`, `REFUND_EXCEEDS_PAYMENT`, `REFUND_EXCEEDS_CREDIT_NOTE`, `INVALID_CREDIT_NOTE`,
`REFUND_NOT_PENDING`, `SELF_APPROVAL`, `INVALID_INVOICE_ITEM`, `DUPLICATE_LINE`, `EXCEEDS_INVOICED_QUANTITY`,
`NOTHING_TO_CREDIT`, `INVOICE_HAS_PAYMENTS`, `CONCURRENT_UPDATE`.

## Implemented in Phase 4

| Method | Path | Permission (scope) | Notes |
|---|---|---|---|
| GET | /kot | `kot.read` (branch) | `branchId`, `stationId?`, `status?` (comma-separated; default the live board PENDING,PREPARING,READY), `updatedSince?` (all statuses), `limit?` (≤ 500). Oldest first. `meta.serverTime` |
| GET | /kot/:id | `kot.read` | Ticket with station, order number, order type, table, notes, items (name, variant, quantity, add-ons, instructions, status, started/ready/served times) and `elapsedSeconds` (stops when ready) |
| PATCH | /kot/items/:id/status | `kot.update_status`; `SERVED` also with `orders.update` | `{ status: PREPARING\|READY\|SERVED }`. Forward only (steps may be skipped); repeating the current status is a no-op |
| POST | /kot/:id/status | same as above | "Bump": moves every unfinished item of the ticket to the status |
| GET | /realtime/events | signed in; topic rights per branch | `branchId`, `after` (last event id processed), `topics?`, `limit?` (≤ 1000). `meta.lastSeq` is the next cursor, `meta.hasMore`. `410 RESYNC_REQUIRED` when the gap is no longer kept |
| WS | /realtime (socket.io path) | access token in `auth.token` | See below |

How kitchen progress moves the order: the ticket follows its slowest item. The order becomes
PREPARING when any item is started, READY only when **every** active item has been sent and is ready
(one ready item never makes the order ready), and for dine-in SERVED when every item is served. A
dine-in order whose bill is already paid completes when its last item is served. Orders only move
forward; items added later go to the kitchen as new tickets without moving a ready order back.

`GET /orders` also accepts `updatedSince` for resync.

**WebSocket protocol** (socket.io, `io(url, { path: '/realtime', auth: { token } })`):

| Direction | Message | Payload |
|---|---|---|
| server → client | `ready` | `{ userId, expiresAt }` after the handshake is accepted |
| client → server | `subscribe` (with ack) | `{ branchId, topics?: [orders, kitchen, tables, payments], since? }` → `{ ok, topics, events?, lastSeq?, resyncRequired? }` or `{ ok: false, error: { code, message } }` |
| client → server | `unsubscribe` (with ack) | `{ branchId }` |
| server → client | `event` | `{ id, type, topic, branchId, entityType, entityId, entityVersion, data, occurredAt }` |
| server → client | `session_expired` | `{ reason: TOKEN_EXPIRED \| SESSION_REVOKED }`, then the socket closes; reconnect with a fresh token and `since` |

Handshake errors arrive as `connect_error` with `data.code` (`UNAUTHENTICATED`, `INVALID_ACCESS_TOKEN`,
`SESSION_INVALID`).

Event types: `order.created`, `order.updated`, `order.cancelled` (topic orders); `kot.created`,
`kot.updated`, `kot.item.updated` (kitchen); `table.status.updated` (tables); `payment.completed`,
`refund.requested`, `refund.completed`, `refund.rejected` (payments). `inventory.low_stock` and
`shift.closed` arrive with Phases 5 and 6.

Phase 4 error codes: `INVALID_STATION`, `ITEM_CANCELLED`, `TICKET_CANCELLED`, `ORDER_CANCELLED`,
`INVALID_TRANSITION`, `RESYNC_REQUIRED`.

## Planned contracts (later phases)

These fix names and shapes now so the frontend and backend can be built against them. Details
may be refined in each phase's PR.

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
