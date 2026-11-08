# Reports and dashboard – what each figure means

Every figure is worked out from the records when you ask for it (bills, credit notes, payments,
refunds, stock ledger, expenses, attendance). Nothing is typed in or stored separately, so the
reports always agree with each other and with the bills. Dates are India dates; a day runs from
midnight to midnight India time.

## Sales words used everywhere

| Word | Meaning |
|---|---|
| **Gross sales** | Menu value of the items billed, before discounts. On a branch whose menu prices include GST, this figure includes GST. |
| **Discounts** | Discounts on bills (item and bill discounts). |
| **Service charge** | Service charge on bills, before GST. |
| **Credit notes** | Value taken back off bills by credit notes (and by cancelling a bill), before GST. Counted on the day the credit note was made. |
| **Net sales** | What the restaurant actually earned from sales: taxable value of bills − credit notes. Excludes GST, includes service charge. |
| **GST collected** | CGST + SGST + IGST on bills − GST on credit notes. This money belongs to the government. |
| **Billed (incl. GST)** | What customers were charged, GST and rounding included, after credit notes. The dashboard calls this *total sales*. |
| **Collected** | Payments actually received (cash, UPI, card…), on the day received. |
| **Refunded** | Refunds actually paid out (approved), on the day they were requested. |
| **Net collected** | Collected − refunded. |
| **Average bill** | Billed amount of bills that are still valid ÷ number of those bills. |

A bill counts on its bill date. If it is later cancelled, the cancellation shows as a credit note on
that day, so both days stay correct.

## Costs and profit

| Word | Meaning |
|---|---|
| **Recipe cost of sales** | Ingredients used by the dishes sold (from the recipes), valued at the average stock cost at that moment. Reversed when an order is voided or reopened. Dishes without a recipe cost nothing here. |
| **Wastage** | Value of stock written off as wasted. |
| **Expenses** | Recorded expenses (rent, electricity, salaries…), counted in full including any GST, on the expense date. Deleted expenses are left out. |
| **Estimated profit** | Net sales − recipe cost − wastage − expenses. |

Buying stock is not an expense in the profit figure: the stock is counted when it is used or wasted.
That is why the profit report shows purchases only for information.

## The reports

| Report | Who can see it by default | What it shows |
|---|---|---|
| Sales (daily, weekly, monthly, annual) | Owner, manager, accountant | The sales words above per day/week/month/year, with totals |
| Products, categories | Owner, manager, accountant | Quantity and net sales per dish and per category, after credit notes |
| GST | Owner, accountant | Totals, by tax rate, HSN/SAC summary, by branch GSTIN, and B2B bills |
| Discounts | Owner, manager, accountant | Who gave discounts, which discounts, and every discounted bill |
| Refunds | Owner, accountant | Paid, waiting and rejected refunds with who asked and who decided |
| Cancellations | Owner, manager, accountant | Cancelled orders (and whether the kitchen had them), items removed from live orders, cancelled bills |
| Payments | Owner, accountant | Money in and out by payment method and by day |
| Inventory | Owner, manager, inventory manager | Per ingredient: opening, received, used, wasted, adjusted, closing, and the value used |
| Wastage | Owner, manager, inventory manager | Wasted stock by ingredient and every entry |
| Purchases | Owner, manager, inventory manager, accountant | Deliveries, supplier bills, payments, and what is owed today, per supplier |
| Expenses | Owner, accountant | By category, payment method and day, and every expense |
| Profit and loss | Owner, accountant | The profit estimate, overall and per branch |
| Branches | Owner, manager, accountant | Orders, bills, net sales, GST, average bill and collections per branch |
| Employees | Owner, manager | Per person: orders taken, bills, money collected, refunds, discounts, cancellations, cash shifts, attendance and hours |

A manager sees only their own branches. Leaving out the branch gives every branch the person may
see the report for.

Each report downloads as **CSV** (opens in Excel; amounts are plain numbers) or **PDF** (printable,
amounts with Indian commas). The GST invoice of any bill also prints as a PDF.

## Dashboard

Today, yesterday, this week (from Monday), this month, or any range, for one branch or all:
total sales, orders (completed, still open, cancelled), average order value, gross and net revenue,
expenses and estimated profit, payment methods, the five best sellers, ingredients below their
minimum level, the ten latest payments and refunds, and each branch's figures. Expenses and
profit appear only for people who may see financial reports; low stock only for people who may see
inventory. Screens refresh the dashboard when an order, payment or low-stock event arrives.
