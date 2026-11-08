# Admin guide

This guide is for the **restaurant owner**, or whoever sets RestaurantOS up and runs it.

The screens are being built, so each task names the API call it uses. The web app will make exactly these calls. Every path below starts with `/api/v1`, and the full reference is Swagger at `/api/docs` (when enabled) or [openapi.json](openapi.json).

## 1. First day: set up the business

Run these steps in order. The installer creates the organization, the first branch and your owner account ([deployment.md](deployment.md)).

1. **Sign in and secure your account.** Sign in with `POST /auth/login`, then change the password with `POST /auth/change-password`.
2. **Organization details.** `PATCH /organization` sets the legal name, GSTIN, PAN, address, phone and email. They print on every invoice.
3. **Branches.** `POST /branches` adds each outlet, with a code, name, GST state code, GSTIN, address and phone. Then `PATCH /branches/:id/settings` sets:
   - `invoicePrefix`: 2–10 letters or digits, for example `BLRIND`. Invoice numbers look like `BLRIND/2627/1`: prefix, financial year (2026-27), then a running number that restarts every April and never has gaps.
   - the service charge %, if you charge one;
   - rounding and the other billing options.

   The state code decides CGST+SGST or IGST, so check it carefully.
4. **Tax rates.** `GET /tax-rates` shows the standard GST slabs (0, 5, 12, 18, 28%). Add a special rate with `POST /tax-rates`. A rate cannot be edited once it has been used, so make a new one instead.
5. **Kitchen stations.** `POST /branches/:id/kitchen-stations` adds stations such as Main, Beverage and Dessert. Each product is sent to its station's screen.
6. **Menu.**
   - Categories: `POST /menu/categories`.
   - Products: `POST /menu/products` with the price, tax rate, HSN/SAC, veg flag and station.
   - Variants (Half/Full): `POST /menu/products/:id/variants`.
   - Add-ons: `POST /menu/modifier-groups`, then `PUT /menu/products/:id/modifier-groups`.
   - Combos: `PUT /menu/products/:id/combo-items`.
   - Branch-specific prices: `PUT /menu/products/:id/branch-prices`.
   - Photos: `POST /menu/products/:id/image`, JPEG, PNG or WebP, up to 2 MB.
7. **Tables.** `POST /branches/:id/tables` adds tables. `PUT /branches/:id/tables/layout` saves the floor plan.
8. **Stock** (optional, but needed for food-cost reports):
   - Ingredients: `POST /ingredients`.
   - Opening stock: `POST /inventory/stock-counts`.
   - Minimum levels: `PUT /inventory/levels`.
   - Recipes: `PUT /recipes/:productId`.

   From then on every sale deducts stock automatically.
9. **Suppliers and expense categories.** `POST /suppliers` and `POST /expense-categories`.
10. **Staff.** See §2.

## 2. People, roles and permissions

### Built-in roles

| Role | Typical person | Can |
|---|---|---|
| Super Admin | You, or IT | Everything, including roles and users |
| Restaurant Owner | Owner, partners | Everything in the business, in every branch |
| Manager | Outlet manager | Run one branch: orders, billing, discounts, refunds, cancellations, stock, staff attendance, reports |
| Cashier | Counter | Orders, bills, payments, own cash drawer |
| Waiter | Floor staff | Tables and orders, sending KOTs, marking food served |
| Kitchen Staff | Chefs | Kitchen screen, marking items "86" (unavailable) |
| Inventory Manager | Storekeeper | Ingredients, stock, wastage, purchase orders, goods receipts |
| Accountant | Accounts | Expenses, supplier bills and payments, financial reports |

### Adding a person

1. `POST /users` creates the login (email, name, phone).
2. `POST /users/:id/roles` assigns a role with a `branchId`. Leave `branchId` out to cover every branch. A person can hold different roles in different branches.
3. If they are on payroll or mark attendance, `POST /employees` creates their staff profile, linked to that user.

When someone leaves, `PATCH /users/:id` with `isActive: false` ends all their sessions immediately. Their history stays in the audit log.

### Changing what a role can do

`GET /permissions` lists every permission with a description. Create your own role with `POST /roles`, or change a custom role with `PUT /roles/:id/permissions`. You can never give out a permission you do not hold yourself.

Keep these permissions with managers and owners only. Each one requires a reason and is written to the audit log:

- `billing.discount.apply` and `billing.discount.override` (for discounts above the limit)
- `billing.price.override`
- `orders.cancel` and `orders.reopen`
- `credit_notes.create`, `refunds.create` and `refunds.approve`
- `menu.price.update`
- `cash.movement` (cash paid in or out of a drawer) and `shifts.close` for other people's shifts

## 3. Daily routine

| When | Who | What |
|---|---|---|
| Opening | Cashier | `POST /cash-sessions/open` with the counted opening cash |
| During service | Everyone | See the [user guide](user-guide.md) |
| Closing | Cashier | `POST /cash-sessions/:id/close` with the counted cash. The difference from the expected amount is recorded and shown in the shift report (`GET /cash-sessions/:id/report`). |
| Closing | Manager | Check `GET /dashboard?range=today`, the cancellations report and the refunds waiting for approval (`GET /refunds?branchId=…&status=PENDING`) |
| Weekly | Storekeeper | Stock count (`POST /inventory/stock-counts`), wastage entries, purchase orders for the low-stock list (`GET /inventory/low-stock`) |
| Monthly | Accountant | GST report for filing (`GET /reports/gst?format=csv`), profit and loss, expense summary, supplier dues |

## 4. Reports and exports

Every report under `/reports/*` takes `from`, `to` (India dates) and an optional `branchId`, and it can be downloaded with `format=csv` or `format=pdf`. The definitions are in [reports.md](reports.md):

- gross sales and net sales;
- what counts as collected;
- how credit notes and refunds are counted;
- how estimated profit is worked out.

Financial figures (expenses, profit) are hidden from anyone without `reports.financial`.

## 5. Corrections: what to do when something is wrong

| Situation | Do this | Never |
|---|---|---|
| Wrong item before billing | Edit the order, or cancel the item with a reason | — |
| Wrong item after billing | Credit note for that line (`POST /invoices/:id/credit-notes`), then a refund if the guest paid (`POST /invoices/:id/refunds`) | Edit or delete the invoice. The database refuses. |
| Whole bill raised by mistake, unpaid | Cancel the invoice with a reason (`POST /invoices/:id/cancel`). The number stays used and shows as cancelled. | Reuse the number |
| Wrong expense | `PATCH /expenses/:id` with a reason. The original stays in the history (`GET /expenses/:id/history`). | — |
| Wrong stock figure | Stock count or adjustment with a reason | Edit movement history |
| Wrong attendance | `PUT /attendance` (manager), with a reason | — |

## 6. Audit log

`GET /audit-logs` shows who did what, when, from which IP, and the before and after values. You can filter by user, action, entity or date. Nobody can edit or delete entries, including the owner and the database user.

## 7. Keeping it healthy

These tasks are for whoever runs the server:

- **Backups:** nightly, with a monthly restore drill ([backup-restore.md](backup-restore.md)).
- **Monitoring and alerts:** [monitoring.md](monitoring.md).
- **Upgrades:** [deployment.md](deployment.md#updating-to-a-new-version).
- **Security practices:** [security.md](security.md).
