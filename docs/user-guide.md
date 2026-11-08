# User guide

This guide is for the people who use RestaurantOS during service: waiters, kitchen staff, cashiers and managers. Each section is one job.

The screens are being built. Until they are ready, each step names the API call the screen will make, so the step-by-step order is already exact.

## Signing in

- Sign in with your work email and password. You stay signed in for the shift. The app refreshes your session quietly, and signs you out after 30 days or when your manager deactivates you.
- **Forgot your password?** Use "Forgot password". The email link works once, within 30 minutes.
- After 5 wrong passwords in a row the account locks for 15 minutes. Ask your manager if you are locked out.
- You only see the branches and buttons your role allows. If a button you need is missing, ask the owner. It is a permission, not a fault.

## Waiter: from seating to serving

1. **Seat the guests.** Tap the table and enter the number of guests (`POST /branches/:id/tables/:tableId/open`). The table turns occupied on every screen.
2. **Take the order.** Add items, pick Half or Full, add-ons and notes such as "less spicy" (`POST /orders`). Prices come from the menu; you cannot type a price.
3. **Send to the kitchen.** Tap **Send KOT** (`POST /orders/:id/confirm`). Each kitchen station gets its own ticket straight away.
4. **Add more later.** Add items and tap **Send KOT** again. Only the new items go to the kitchen.
5. **Serve.** When the kitchen marks food ready you see it on your screen. Mark it **Served** when it reaches the table.
6. **Move or join tables:**
   - **Transfer** moves the guests to another table.
   - **Merge** joins two tables into one bill.
   - **Split** divides one table's items into separate bills.
7. If someone else changed the same order a moment ago, you will see "This order was changed on another device". Refresh and try again; nothing is lost.

## Kitchen: the KOT screen

- Tickets appear in order, with the table, waiter notes, add-ons and a timer. Each station sees only its own tickets.
- Tap an item to **Start**, then **Ready**. When every item of an order is ready, the order turns ready for the waiter.
- **Out of something?** Mark the product **Unavailable** ("86"). It disappears from the order screens in this branch until you turn it back on.
- If the screen loses Wi-Fi it catches up on reconnect, and no ticket is skipped.

## Cashier: billing and payment

1. **Open your drawer** at the start of the shift, with the cash you counted (`POST /cash-sessions/open`).
2. **Make the bill.** Choose the table or order and tap **Bill** (`POST /invoices`). This:
   - calculates GST (CGST+SGST, or IGST for another state);
   - applies the service charge if your branch uses one;
   - rounds to the rupee;
   - gives the bill its GST invoice number.

   The table shows **Bill pending**.
3. **Take payment.** You can use cash, card or UPI, or a mix (`POST /invoices/:id/payments`). Part payments are allowed, and the screen shows the balance. The app will not take more than the balance, so a double tap never charges twice.
4. **Takeaway or quick counter sale.** Do it in one step with **Checkout** (`POST /billing/checkout`), entering the payments together.
5. **Print or share** the invoice (`GET /invoices/:id/pdf`).
6. **Business customer?** Enter their GSTIN and name before billing so the invoice shows them as the buyer.
7. **Close your drawer** at the end: count the cash and enter it (`POST /cash-sessions/:id/close`). The system shows what it expected and records any difference.

**You cannot change a bill once it is made.** That is the law for GST invoices. If something is wrong, ask a manager for a credit note.

## Manager: approvals and fixes

| Need | How | Notes |
|---|---|---|
| Discount | On the order: percentage or amount, for one item or the whole bill (`POST /orders/:id/discounts`) | A reason is required. Large discounts need the override permission. |
| Cancel an item or order | Cancel, with a reason (`POST /orders/:id/cancel`) | Shows in the cancellations report with your name and the reason |
| Guest returns an item after billing | **Credit note** for that line (`POST /invoices/:id/credit-notes`), then **Refund** against the payment it came from (`POST /invoices/:id/refunds`) | The refund can never be more than was paid |
| Approve a cashier's refund | `GET /refunds?branchId=…&status=PENDING`, then approve or reject | — |
| Cash paid out of the drawer | `POST /cash-sessions/:id/movements` | Use it for supplier cash payments, tips paid out and the like |
| Shop expense | `POST /expenses`, plus a photo or PDF of the bill (`POST /expenses/:id/receipt`) | Receipts are private. Only people who can see expenses can open them. |
| Today at a glance | Dashboard (`GET /dashboard?range=today`) | Sales, orders, payment mix, best sellers, low stock, recent payments |

## Staff: attendance

- **Clock in** when you arrive and **Clock out** when you leave (`POST /attendance/clock-in`, `POST /attendance/clock-out`). Night shifts past midnight count for the day you started.
- Forgot to clock out? Tell your manager. They will correct it, and the change is recorded.
- See your own hours under **My attendance** (`GET /attendance/me`).

## Storekeeper: stock

- **Receive goods** against a purchase order (`POST /purchase-orders/:id/receipts`). Stock goes up, and the supplier bill can then be matched.
- **Wastage** (spoilt, spilt, expired): `POST /inventory/wastage`, with a reason.
- **Stock count:** count, enter the numbers (`POST /inventory/stock-counts`), and the system records the difference.
- **Low stock** shows everything below its minimum level (`GET /inventory/low-stock`).

## When something goes wrong

| You see | Means | Do |
|---|---|---|
| "This order was changed on another device" | Someone else edited it first | Refresh and redo your change |
| "Amount is more than the balance" | The bill is already (partly) paid | Refresh the bill and check the balance |
| "No open shift" | Your cash drawer is not open | Open your drawer first |
| "Missing permission" | Your role cannot do this | Ask a manager |
| "Too many requests" | Many tries in a short time | Wait a minute |
| Any other error | Something unexpected | Tell your manager the **reference code** shown with the error. It points the support team to the exact problem. |
