# RestaurantOS – Database design

PostgreSQL 16, managed with Prisma migrations. The canonical definition is
[`apps/api/prisma/schema.prisma`](../apps/api/prisma/schema.prisma) (64 tables); rules Prisma
cannot express live in
[`migrations/20261106040000_integrity_constraints`](../apps/api/prisma/migrations/20261106040000_integrity_constraints/migration.sql)
(check constraints, partial unique indexes, append-only and immutability triggers).

## Conventions

| Topic | Rule |
|---|---|
| Keys | UUID primary keys (`audit_logs` uses a bigint sequence for cheap ordered inserts). |
| Naming | snake_case tables and columns. |
| Tenancy | `organization_id` on every restaurant-owned row; `branch_id` where it belongs to an outlet. Branch-owned rows use a composite FK `(branch_id, organization_id) → branches (id, organization_id)`. Child rows (e.g. `order_items`) inherit tenancy through their parent. |
| Money | `NUMERIC(14,2)`; unit costs `NUMERIC(14,4)`; quantities `NUMERIC(14,3)`; rates `NUMERIC(6,3)`. |
| Time | `timestamptz(3)`; business dates (`expense_date`, `work_date`) are `date`. Default time zone Asia/Kolkata at the organization level. |
| Soft delete | Only for master data people may want back or that history points to: organizations, branches, users, tables, categories, products, ingredients, suppliers, employees, expenses. Transactions (orders, invoices, payments, movements) are never deleted; they are cancelled or reversed. |
| Concurrency | `version` columns on `orders`, `restaurant_tables`, `inventory_balances` for optimistic locking; row locks for sequences and balances inside transactions. |

## Entity-relationship diagrams

Split by domain for readability. Columns shown are the important ones; see the schema for all.

### Organization, access control and audit

```mermaid
erDiagram
  organizations ||--o{ branches : has
  branches ||--|| branch_settings : configures
  organizations ||--o{ users : employs
  organizations ||--o{ roles : defines
  roles ||--o{ role_permissions : grants
  permissions ||--o{ role_permissions : "granted by"
  users ||--o{ user_roles : holds
  roles ||--o{ user_roles : "assigned as"
  branches |o--o{ user_roles : "scoped to (NULL = all)"
  users ||--o{ sessions : "signs in"
  sessions ||--o{ refresh_tokens : rotates
  users ||--o{ password_reset_tokens : requests
  branches ||--o{ document_sequences : numbers

  organizations {
    uuid id PK
    text name
    varchar gstin
    varchar state_code
  }
  branches {
    uuid id PK
    uuid organization_id FK
    varchar code UK
    varchar state_code
    varchar gstin
  }
  users {
    uuid id PK
    uuid organization_id FK
    text email UK
    text password_hash
    int failed_login_attempts
    timestamptz locked_until
  }
  roles {
    uuid id PK
    uuid organization_id FK
    varchar key UK
    bool is_system
  }
  permissions {
    uuid id PK
    varchar code UK
    varchar module
  }
  user_roles {
    uuid id PK
    uuid user_id FK
    uuid role_id FK
    uuid branch_id FK "nullable"
  }
  sessions {
    uuid id PK
    uuid user_id FK
    timestamptz expires_at
    timestamptz revoked_at
  }
  refresh_tokens {
    uuid id PK
    uuid session_id FK
    varchar token_hash UK
    timestamptz used_at
    uuid replaced_by_id
  }
  audit_logs {
    bigint id PK
    uuid organization_id
    uuid actor_user_id
    varchar action
    varchar entity_type
    json before
    json after
  }
  idempotency_keys {
    uuid id PK
    uuid organization_id
    varchar scope
    varchar key
    varchar request_hash
    json response_body
  }
  document_sequences {
    uuid id PK
    uuid branch_id FK
    enum type
    varchar prefix
    varchar period
    int next_value
  }
```

### Menu and floor

```mermaid
erDiagram
  categories ||--o{ categories : parent
  categories ||--o{ products : contains
  tax_rates |o--o{ products : "taxed at"
  products ||--o{ product_variants : "sold as"
  products ||--o{ product_modifier_groups : offers
  modifier_groups ||--o{ product_modifier_groups : "attached to"
  modifier_groups ||--o{ modifiers : contains
  products ||--o{ branch_product_prices : "priced per branch"
  product_variants |o--o{ branch_product_prices : "priced per branch"
  products ||--o{ combo_items : "combo of"
  branches ||--o{ kitchen_stations : has
  branches ||--o{ restaurant_tables : has
  restaurant_tables ||--o{ table_sessions : "occupied by"
  table_sessions |o--o{ table_sessions : "merged into"

  products {
    uuid id PK
    varchar sku UK
    numeric base_price
    varchar hsn_sac
    varchar station_code
    bool is_available
  }
  product_variants {
    uuid id PK
    uuid product_id FK
    text name
    numeric price
  }
  tax_rates {
    uuid id PK
    numeric rate
    numeric cgst_rate
    numeric sgst_rate
    numeric igst_rate
  }
  branch_product_prices {
    uuid branch_id FK
    uuid product_id FK
    uuid variant_id FK
    numeric price
  }
  restaurant_tables {
    uuid id PK
    uuid branch_id FK
    varchar label UK
    int capacity
    enum status
    int version
  }
  table_sessions {
    uuid id PK
    uuid table_id FK
    timestamptz opened_at
    timestamptz closed_at
  }
```

### Orders, kitchen and billing

```mermaid
erDiagram
  table_sessions |o--o{ orders : seats
  orders ||--o{ order_items : contains
  order_items ||--o{ order_item_modifiers : "with add-ons"
  orders ||--o{ order_status_history : "moved through"
  orders ||--o{ applied_discounts : discounted
  order_items |o--o{ applied_discounts : discounted
  discounts |o--o{ applied_discounts : "scheme"
  orders ||--o{ kitchen_tickets : "sent as"
  kitchen_stations |o--o{ kitchen_tickets : "prepared at"
  kitchen_tickets ||--o{ kitchen_ticket_items : lists
  order_items ||--o{ kitchen_ticket_items : "prepared as"
  orders ||--o{ invoices : "billed by"
  document_sequences ||--o{ invoices : numbers
  invoices ||--o{ invoice_items : lines
  order_items |o--o{ invoice_items : "billed as"
  orders |o--o{ payments : "paid by"
  payments ||--o{ payment_allocations : "allocated to"
  invoices ||--o{ payment_allocations : "settled by"
  payments ||--o{ refunds : "refunded by"
  invoices ||--o{ refunds : "refunded on"
  invoices ||--o{ credit_notes : "corrected by"
  credit_notes ||--o{ credit_note_items : lines
  credit_notes |o--o{ refunds : "backs"

  orders {
    uuid id PK
    varchar order_number UK
    enum order_type
    enum status
    numeric grand_total
    numeric paid_amount
    int version
  }
  order_items {
    uuid id PK
    text product_name
    numeric unit_price
    numeric tax_rate
    numeric line_total
    enum kitchen_status
  }
  invoices {
    uuid id PK
    varchar invoice_number UK
    enum status
    enum supply_type
    varchar place_of_supply
    json seller_details
    numeric grand_total
  }
  payments {
    uuid id PK
    enum method
    numeric amount
    varchar idempotency_key UK
    uuid cash_session_id
  }
  refunds {
    uuid id PK
    uuid payment_id FK
    uuid invoice_id FK
    numeric amount
    text reason
  }
  credit_notes {
    uuid id PK
    varchar credit_note_number UK
    numeric total_amount
  }
```

### Inventory and purchasing

```mermaid
erDiagram
  units ||--o{ ingredients : "base unit"
  ingredients ||--o{ inventory_balances : "stock per branch"
  ingredients ||--o{ stock_movements : ledger
  products ||--o{ recipes : "made by"
  recipes ||--o{ recipe_items : uses
  ingredients ||--o{ recipe_items : "used in"
  ingredients ||--o{ stock_adjustments : adjusted
  ingredients ||--o{ wastage_records : wasted
  suppliers ||--o{ purchase_orders : receives
  purchase_orders ||--o{ purchase_order_items : lines
  purchase_orders |o--o{ goods_receipts : "delivered as"
  goods_receipts ||--o{ goods_receipt_items : lines
  purchase_order_items |o--o{ goods_receipt_items : fulfils
  suppliers ||--o{ supplier_invoices : bills
  supplier_invoices |o--o{ goods_receipts : covers
  suppliers ||--o{ supplier_payments : "paid by"
  supplier_invoices |o--o{ supplier_payments : settles

  inventory_balances {
    uuid branch_id FK
    uuid ingredient_id FK
    numeric quantity
    numeric minimum_level
    numeric average_cost
    int version
  }
  stock_movements {
    uuid id PK
    enum type
    numeric quantity "signed"
    numeric balance_after
    varchar reference_type
    uuid reference_id
    varchar dedupe_key UK
  }
  recipe_items {
    uuid recipe_id FK
    uuid ingredient_id FK
    numeric quantity
    uuid unit_id FK
    numeric wastage_percent
  }
  purchase_order_items {
    numeric quantity
    numeric received_quantity
    numeric unit_price
  }
  supplier_invoices {
    varchar invoice_number
    numeric total
    numeric paid_amount
    enum status
  }
```

### Finance and people

```mermaid
erDiagram
  expense_categories ||--o{ expenses : groups
  employees |o--o{ expenses : "claimed by"
  cash_sessions |o--o{ expenses : "paid from drawer"
  users ||--o{ cash_sessions : "cashier of"
  cash_sessions ||--o{ cash_movements : records
  cash_sessions |o--o{ payments : "cash taken in"
  users |o--|| employees : "login of"
  employees ||--o{ attendance : "clocks"
  employees ||--o{ employee_shifts : "scheduled"

  cash_sessions {
    uuid id PK
    numeric opening_balance
    numeric expected_cash
    numeric actual_cash
    numeric discrepancy
    enum status
  }
  cash_movements {
    uuid id PK
    enum type
    numeric amount "signed"
  }
  expenses {
    uuid id PK
    numeric amount
    date expense_date
    enum payment_method
    timestamptz deleted_at
  }
  attendance {
    uuid employee_id FK
    date work_date UK
    timestamptz clock_in_at
    timestamptz clock_out_at
  }
```

## Integrity rules enforced by PostgreSQL

| Area | Rule | Mechanism |
|---|---|---|
| Tenancy | A branch-owned row's branch is in the same organization | Composite FK to `branches (id, organization_id)` |
| Tenancy | A user's role belongs to the user's organization | Composite FKs on `user_roles` |
| Access | One assignment per (user, role, branch), with NULL = org-wide counted once | `UNIQUE … NULLS NOT DISTINCT` |
| Orders | Non-negative amounts, discount ≤ subtotal, round-off within ±1 | `orders_amounts_valid` |
| Orders | Cancelled orders and items carry a reason and the cancelling user | `*_cancel_reason_required` |
| Orders | Dine-in orders have a table session; order numbers unique per branch | check + unique |
| Tables | At most one open session per table | partial unique index |
| Invoices | Tax components sum to the tax total; CGST/SGST only intra-state, IGST only inter-state; paid ≤ total; refunded ≤ paid | `invoices_amounts_valid` |
| Invoices | One non-cancelled invoice per order; numbers unique per series and per organization | partial unique + unique |
| Invoices | Finalized invoices and their items cannot be changed or deleted (payment progress excepted) | triggers `invoices_guard_finalized`, `invoice_items_guard_finalized` |
| Payments | Positive amounts, idempotency key unique per organization | check + unique |
| Tax rates | CGST = SGST, CGST + SGST = rate, IGST = rate | `tax_rates_valid` |
| Stock | Movement sign matches its type; each business event deducts once | check + unique `dedupe_key` |
| Ledgers | `audit_logs`, `stock_movements`, `order_status_history`, `cash_movements` are append-only | `ros_forbid_mutation` trigger |
| Cash | One open shift per cashier per branch; a closed shift has expected, actual and discrepancy = actual − expected | partial unique + check |
| Formats | GSTIN, state code, HSN/SAC, lower-case email | checks |

These rules are covered by `apps/api/test/db-integrity.e2e-spec.ts`, which writes straight
through Prisma and expects PostgreSQL to refuse.

## Migrations and seeding

```bash
pnpm --filter @restaurant-os/api prisma:migrate        # prisma migrate deploy
pnpm --filter @restaurant-os/api db:seed               # permission catalog + units
SEED_DEMO=true pnpm --filter @restaurant-os/api db:seed  # + demo organization and users
```

CI also runs `prisma migrate diff` to prove the migrations and `schema.prisma` describe the same
database (no drift).

## Backups and restore

* Production: managed PostgreSQL with point-in-time recovery (WAL archiving), daily snapshots kept
  for 30 days, and a monthly restore drill into a scratch database.
* Self-hosted: `pg_dump -Fc` nightly to S3-compatible storage with lifecycle rules, plus WAL
  archiving (e.g. pgBackRest or WAL-G) for point-in-time recovery.

```bash
# backup
pg_dump --format=custom --no-owner --file=ros-$(date +%F).dump "$DATABASE_URL"
# restore into an empty database
pg_restore --no-owner --clean --if-exists --dbname="$RESTORE_DATABASE_URL" ros-YYYY-MM-DD.dump
```

Full runbooks are a Phase 8 deliverable.
