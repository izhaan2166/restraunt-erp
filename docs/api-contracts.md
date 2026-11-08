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
| POST | /invoices/:id/refunds | `refunds.create` **Idem.** | `{ paymentId, amount, reason, method?, creditNoteId?, restock? }` (`restock: true` needs `creditNoteId` and puts the credited items' ingredients back in stock when the refund completes). Without `refunds.approve` the refund is PENDING until a manager approves it |
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
| client → server | `subscribe` (with ack) | `{ branchId, topics?: [orders, kitchen, tables, payments, inventory, shifts], since? }` → `{ ok, topics, events?, lastSeq?, resyncRequired? }` or `{ ok: false, error: { code, message } }` |
| client → server | `unsubscribe` (with ack) | `{ branchId }` |
| server → client | `event` | `{ id, type, topic, branchId, entityType, entityId, entityVersion, data, occurredAt }` |
| server → client | `session_expired` | `{ reason: TOKEN_EXPIRED \| SESSION_REVOKED }`, then the socket closes; reconnect with a fresh token and `since` |

Handshake errors arrive as `connect_error` with `data.code` (`UNAUTHENTICATED`, `INVALID_ACCESS_TOKEN`,
`SESSION_INVALID`).

Event types: `order.created`, `order.updated`, `order.cancelled` (topic orders); `kot.created`,
`kot.updated`, `kot.item.updated` (kitchen); `table.status.updated` (tables); `payment.completed`,
`refund.requested`, `refund.completed`, `refund.rejected` (payments); `inventory.low_stock`,
`inventory.restocked` (inventory, Phase 5); `shift.opened`, `shift.closed` (shifts, Phase 6, needs `shifts.read`).

Phase 4 error codes: `INVALID_STATION`, `ITEM_CANCELLED`, `TICKET_CANCELLED`, `ORDER_CANCELLED`,
`INVALID_TRANSITION`, `RESYNC_REQUIRED`.

## Implemented in Phase 5

Stock rules (units, average cost, when sales take stock, negative stock) are explained in
[inventory.md](inventory.md). Quantities in requests may use any unit of the same kind as the
ingredient's base unit (`kg` for an ingredient kept in `g`); stock is always reported in the base unit.

**Ingredients, stock and recipes**

| Method | Path | Permission (scope) | Notes |
|---|---|---|---|
| GET | /units | signed in | g, kg, ml, l, pc, dozen with conversion factors |
| GET | /ingredients | `inventory.read` (any branch) | `search?`, `includeInactive?`, paginated |
| GET | /ingredients/:id | `inventory.read` | |
| POST | /ingredients | `inventory.manage` (any branch) | `{ name, sku?, baseUnit: g\|ml\|pc, category? }`. `INVALID_BASE_UNIT`, `DUPLICATE_NAME` |
| PATCH | /ingredients/:id | `inventory.manage` | name, sku, category, isActive (base unit is fixed once created) |
| DELETE | /ingredients/:id | `inventory.manage` | Soft delete. `INGREDIENT_IN_USE` (in a recipe), `INGREDIENT_HAS_STOCK` |
| GET | /inventory | `inventory.read` (branch) | `branchId`, `search?`. Per ingredient: quantity, minimumLevel, averageCost, stockValue, isLow, isNegative |
| GET | /inventory/low-stock | `inventory.read` (branch) | Same rows, only those below their minimum level |
| PUT | /inventory/levels | `inventory.manage` (branch) | `{ branchId, levels: [{ ingredientId, minimumLevel }] }` |
| GET | /inventory/movements | `inventory.read` (branch) | `branchId`, `ingredientId?`, `type?` (comma-separated), `from?`, `to?`; paginated ledger with `balanceAfter` and `value` |
| POST | /inventory/adjustments | `inventory.adjust` (branch) **Idem.** | `{ branchId, ingredientId, quantity, unit?, reason, direction: IN\|OUT }`. OUT below zero → `409 INSUFFICIENT_STOCK` |
| POST | /inventory/stock-counts | `inventory.adjust` (branch) **Idem.** | `{ branchId, reason, counts: [{ ingredientId, quantity, unit?, unitCost? }] }`. Books the difference; the first count of an ingredient is its opening stock (valued at `unitCost`) |
| POST | /inventory/wastage | `inventory.wastage` (branch) **Idem.** | `{ branchId, ingredientId, quantity, unit?, reason }`. Valued at the average cost; cannot go below zero |
| GET | /recipes/:productId | `inventory.read` | `variantId?`, `branchId?` (adds estimated cost per portion at that branch's average cost) |
| PUT | /recipes/:productId | `recipes.manage` | `{ variantId?, yieldQuantity?, items: [{ ingredientId, quantity, unit, wastagePercent? }] }`. Replaces the active recipe; the old one is kept inactive. `UNIT_MISMATCH`, `DUPLICATE_LINE` |
| DELETE | /recipes/:productId | `recipes.manage` | `variantId?` |
| GET | /branches/:branchId/settings | `settings.read` (branch) | |
| PATCH | /branches/:branchId/settings | `settings.update` (branch) | `taxPricingMode`, `roundingMode`, `invoicePrefix`, `stockDeductionPolicy` (ON_ORDER_CONFIRM \| ON_ORDER_COMPLETE \| NONE), `allowNegativeStock`, `serviceChargePercent`, `maxCashierDiscountPct`. `DUPLICATE_PREFIX` |

When a branch sets `allowNegativeStock: false`, confirming an order or sending a KOT that needs more
than is in stock fails with `409 INSUFFICIENT_STOCK` and `details.short: [{ ingredientId, name, onHand, required }]`.

**Suppliers and purchasing**

| Method | Path | Permission (scope) | Notes |
|---|---|---|---|
| GET | /suppliers | `suppliers.read` (any branch) | `search?`, `includeInactive?`. Each with `outstanding` and `overdue` (over the branches whose purchases you may see) |
| GET | /suppliers/:id | `suppliers.read` | Same fields |
| GET | /suppliers/:id/transactions | `suppliers.read` + `purchases.read` per branch | `branchId?`. Invoices (debit) and payments (credit) in date order with running `balance` |
| POST | /suppliers | `suppliers.manage` | `{ name, contactPerson?, phone?, email?, gstin?, stateCode?, address?, paymentTermsDays? }`. GSTIN checked; state code taken from it. `DUPLICATE_NAME` |
| PATCH | /suppliers/:id | `suppliers.manage` | Any field above plus `isActive` |
| DELETE | /suppliers/:id | `suppliers.manage` | Soft delete. `SUPPLIER_IN_USE` while it has open orders or unpaid bills |
| GET | /purchase-orders | `purchases.read` (branch) | `branchId`, `status?`, `supplierId?`, `pending?` (still waiting for delivery), `search?` |
| GET | /purchase-orders/:id | `purchases.read` | Lines with `receivedQuantity` and `remainingQuantity`, and its goods receipts |
| POST | /purchase-orders | `purchases.create` (branch) **Idem.** | `{ branchId, supplierId, expectedDate?, notes?, items: [{ ingredientId, unit, quantity, unitPrice, taxRate? }] }`. Totals computed on the server. Number `{prefix}-PO/{FY}/{n}`. Starts as DRAFT |
| PATCH | /purchase-orders/:id | `purchases.create` | Drafts only (`PO_NOT_EDITABLE`); `items` replaces every line |
| POST | /purchase-orders/:id/approve | `purchases.approve` | DRAFT → ORDERED (`PO_NOT_DRAFT`) |
| POST | /purchase-orders/:id/cancel | `purchases.create` for drafts, `purchases.approve` once ordered | `{ reason }`. Cancels what has not arrived; received goods stay. `PO_NOT_CANCELLABLE` when fully received |
| POST | /purchase-orders/:id/receipts | `purchases.receive` **Idem.** | `{ items: [{ purchaseOrderItemId, quantity, unitPrice? }], notes? }`. Partial deliveries allowed; more than ordered → `409 OVER_RECEIPT` (details: ordered, received, remaining). Order not approved/closed → `PO_NOT_RECEIVABLE`. Number `{prefix}-GRN/{FY}/{n}`. Response adds `purchaseOrderStatus` |
| POST | /goods-receipts | `purchases.receive` (branch) **Idem.** | Goods bought without an order: `{ branchId, supplierId, notes?, items: [{ ingredientId, unit, quantity, unitPrice }] }` |
| GET | /goods-receipts | `purchases.read` (branch) | `branchId`, `supplierId?`, `purchaseOrderId?`; each with `totalValue` |
| GET | /goods-receipts/:id | `purchases.read` | |
| POST | /supplier-invoices | `supplier_payments.create` (branch) **Idem.** | `{ branchId, supplierId, purchaseOrderId?, goodsReceiptIds?, invoiceNumber, invoiceDate, dueDate?, subtotal, taxTotal }`. Total = subtotal + tax. Due date defaults to invoice date + the supplier's payment terms. `DUPLICATE_SUPPLIER_INVOICE`, `GRN_ALREADY_INVOICED` |
| GET | /supplier-invoices | `purchases.read` (branch) | `branchId`, `supplierId?`, `status?`, `overdue?`; each with `outstanding`, `isOverdue` |
| GET | /supplier-invoices/:id | `purchases.read` | With payments and goods receipts |
| POST | /supplier-invoices/:id/cancel | `supplier_payments.create` | `{ reason }`. Only with nothing paid (`INVOICE_HAS_PAYMENTS`); frees its goods receipts |
| POST | /supplier-payments | `supplier_payments.create` **Idem.** | `{ supplierInvoiceId, amount, method, reference? }`. More than outstanding → `422 AMOUNT_EXCEEDS_OUTSTANDING`; paid or cancelled bill → `INVOICE_NOT_PAYABLE`. Returns `{ payment, invoice }` |
| GET | /supplier-payments | `purchases.read` (branch) | `branchId`, `supplierId?` |

Phase 5 error codes: `INVALID_BASE_UNIT`, `INVALID_UNIT`, `UNIT_MISMATCH`, `INVALID_QUANTITY`,
`INVALID_INGREDIENT`, `INGREDIENT_INACTIVE`, `INGREDIENT_IN_USE`, `INGREDIENT_HAS_STOCK`,
`INSUFFICIENT_STOCK`, `DUPLICATE_LINE`, `INVALID_YIELD`, `RESTOCK_NEEDS_CREDIT_NOTE`,
`SUPPLIER_INACTIVE`, `SUPPLIER_IN_USE`, `PO_NOT_EDITABLE`, `PO_NOT_DRAFT`, `PO_NOT_CANCELLABLE`,
`PO_NOT_RECEIVABLE`, `INVALID_PO_ITEM`, `OVER_RECEIPT`, `INVALID_PURCHASE_ORDER`,
`INVALID_GOODS_RECEIPT`, `GRN_ALREADY_INVOICED`, `DUPLICATE_SUPPLIER_INVOICE`, `INVALID_DUE_DATE`,
`INVOICE_CANCELLED`, `INVOICE_HAS_PAYMENTS`, `INVOICE_NOT_PAYABLE`, `AMOUNT_EXCEEDS_OUTSTANDING`,
`DUPLICATE_PREFIX`.

## Implemented in Phase 6

Rules for cash drawers, expenses and attendance in plain words: [cash-and-staff.md](cash-and-staff.md).

**Cash shifts** (one open drawer per cashier per branch)

| Method | Path | Permission (scope) | Notes |
|---|---|---|---|
| POST | /cash-sessions/open | `shifts.open` (branch) **Idem.** | `{ branchId, openingBalance, terminal? }`. `SHIFT_ALREADY_OPEN` |
| GET | /cash-sessions/current | `shifts.open` (branch) | `branchId`. Your open shift with live `expectedCash`, or `null` |
| GET | /cash-sessions | `shifts.read` (branch) | `branchId`, `status?`, `userId?`, `from?`, `to?`; paginated |
| GET | /cash-sessions/summary | `shifts.read` (branch) | `branchId`, `from`, `to`. Per cashier: shifts, open shifts, cash sales, refunds, cash in/out, expenses, shortages, overages, net discrepancy |
| GET | /cash-sessions/:id | own shift, or `shifts.read` | With movements |
| GET | /cash-sessions/:id/report | own shift, or `shifts.read` | Shift report: opening, cash sales, refunds, cash in/out, expenses, expected, actual, discrepancy; payments and refunds by method; total collected |
| POST | /cash-sessions/:id/movements | `cash.movement` (another cashier's drawer also needs `shifts.read`) **Idem.** | `{ type: CASH_IN\|CASH_OUT, amount, reason }`. Taking out more than is in the drawer → `409 INSUFFICIENT_CASH` |
| POST | /cash-sessions/:id/close | `shifts.close` (another cashier's shift also needs `shifts.read`) | `{ actualCash, notes? }` → 200. A shortage or overage needs `notes` (`422 DISCREPANCY_NOTE_REQUIRED`, details `expectedCash`, `discrepancy`). A closed shift can never change (`SHIFT_CLOSED`) |

Cash payments (`POST /payments`) and cash refunds now go through a drawer: the payment goes into the
receiving cashier's open shift, a cash refund comes out of the requester's open shift (else the
approver's). With no open shift → `409 NO_OPEN_SHIFT`, unless the branch sets `cashRequiresShift: false`
in `PATCH /branches/:id/settings`. Closing a shift with a difference also writes a `shift.discrepancy`
notification.

**Expenses**

| Method | Path | Permission (scope) | Notes |
|---|---|---|---|
| GET | /expense-categories | `expenses.read` (any branch) | `includeInactive?` |
| POST | /expense-categories | `expenses.create` | `{ name }`. `DUPLICATE_NAME` |
| PATCH | /expense-categories/:id | `expenses.update` | name, isActive |
| GET | /expenses | `expenses.read` (branch) | `branchId`, `from?`, `to?`, `categoryId?`, `employeeId?`, `paymentMethod?`, `includeDeleted?`; paginated |
| GET | /expenses/summary | `expenses.read` (branch) | `branchId`, `from`, `to`. Count, total, tax, by category and by payment method |
| GET | /expenses/:id | `expenses.read` | |
| GET | /expenses/:id/history | `expenses.read` | Every change from the audit log, with who made it and the reason |
| POST | /expenses | `expenses.create` (branch) **Idem.** | `{ branchId, categoryId, amount (GST included), taxAmount?, description, expenseDate, paymentMethod, paidTo?, employeeId?, fromCashDrawer? }`. `fromCashDrawer` takes the cash out of your open shift (`DRAWER_NEEDS_CASH`, `NO_OPEN_SHIFT`, `INSUFFICIENT_CASH`) |
| PATCH | /expenses/:id | `expenses.update` | Any field above plus a required `reason`. Changing a drawer expense's amount moves the difference through the drawer while the shift is open (`SHIFT_CLOSED` after) |
| DELETE | /expenses/:id | `expenses.delete` | `{ reason }` → 204. Soft delete; drawer cash is put back while the shift is open |
| POST | /expenses/:id/receipt | creator with `expenses.create`, or `expenses.update` | multipart field `receipt`: PDF, JPEG, PNG or WebP up to `UPLOAD_MAX_RECEIPT_BYTES` (5 MB). `UNSUPPORTED_FILE`, `FILE_REQUIRED` |

Default roles: managers and accountants record expenses, accountants (and owners) edit them, only
owners delete them.

**Employees and attendance** (work dates are India dates)

| Method | Path | Permission (scope) | Notes |
|---|---|---|---|
| GET | /employees/me | signed in | Your own profile |
| GET | /employees | `employees.read` | `branchId?`, `search?`, `includeInactive?`. Only staff of branches you can see; salary only for people who manage them |
| GET | /employees/:id | `employees.read` | With the linked login, its roles and branches |
| GET | /employees/:id/activity | `employees.read` | Recent logins (login/logout time, device, still active) and audited actions |
| POST | /employees | `employees.manage` (the employee's branch) | `{ employeeCode, fullName, phone?, email?, designation?, joiningDate?, monthlySalary?, primaryBranchId?, userId? }`. Code is upper-cased. `DUPLICATE_EMPLOYEE_CODE`, `USER_ALREADY_LINKED`, `INVALID_USER`, `INVALID_BRANCH`. Head-office staff (no branch) need an organization-wide role |
| PATCH | /employees/:id | `employees.manage` | Any field above plus `isActive`; audited with before/after |
| DELETE | /employees/:id | `employees.manage` | Soft delete → 204. `EMPLOYEE_CLOCKED_IN` |
| POST | /attendance/clock-in | `attendance.self` (branch) | `{ branchId, notes? }`. `EMPLOYEE_PROFILE_REQUIRED` (422), `EMPLOYEE_INACTIVE`, `ALREADY_CLOCKED_IN`, `ALREADY_CLOCKED_OUT` |
| POST | /attendance/clock-out | `attendance.self` | `{ notes? }` → 200. Works after midnight for a late shift. `NOT_CLOCKED_IN`; a clock-in over 20 hours old → `CLOCK_IN_TOO_OLD` |
| GET | /attendance/me | signed in | `from`, `to` |
| PUT | /attendance | `attendance.manage` (branch) | `{ branchId, employeeId, workDate, status: PRESENT\|HALF_DAY\|ABSENT\|LEAVE, clockInAt?, clockOutAt?, notes?, reason }`. Records or corrects a day; audited. `FUTURE_DATE`, `TIMES_NOT_ALLOWED`, `CLOCK_IN_REQUIRED`, `INVALID_TIMES` |
| GET | /attendance | `employees.read` (branch) | `branchId`, `from`, `to`, `employeeId?`. Each with `hoursWorked` |
| GET | /attendance/summary | `employees.read` (branch) | Same filters. Per employee: present, half days, absent, leave, hours, still clocked in |

Date ranges are limited to 366 days (`RANGE_TOO_LONG`).

Phase 6 error codes: `SHIFT_ALREADY_OPEN`, `SHIFT_CLOSED`, `NO_OPEN_SHIFT`, `INSUFFICIENT_CASH`,
`DISCREPANCY_NOTE_REQUIRED`, `INVALID_AMOUNT`, `INVALID_TAX`, `INVALID_CATEGORY`, `CATEGORY_INACTIVE`,
`DRAWER_NEEDS_CASH`, `EXPENSE_FROM_DRAWER`, `EXPENSE_DELETED`, `UNSUPPORTED_FILE`, `FILE_REQUIRED`,
`FUTURE_DATE`, `DUPLICATE_EMPLOYEE_CODE`, `USER_ALREADY_LINKED`, `INVALID_USER`, `INVALID_EMPLOYEE`,
`INVALID_BRANCH`, `EMPLOYEE_CLOCKED_IN`, `EMPLOYEE_INACTIVE`, `EMPLOYEE_PROFILE_REQUIRED`,
`ALREADY_CLOCKED_IN`, `ALREADY_CLOCKED_OUT`, `NOT_CLOCKED_IN`, `CLOCK_IN_TOO_OLD`, `CLOCK_IN_REQUIRED`,
`TIMES_NOT_ALLOWED`, `INVALID_TIMES`, `RANGE_TOO_LONG`.

## Planned contracts (later phases)

These fix names and shapes now so the frontend and backend can be built against them. Details
may be refined in each phase's PR.

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
