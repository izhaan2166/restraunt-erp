# User guide

This guide is for the people who use RestaurantOS during service: waiters, kitchen staff, cashiers and managers. Each section is one job.

Open the app at your restaurant's address (for example `https://pos.yourrestaurant.in`) on a tablet, phone or computer. Steps marked _(screen coming)_ work in the system already but their screen arrives in a later update; a manager can do them meanwhile through the API.

## Signing in

- Sign in with your work email and password. You stay signed in for the shift, even if you reload the page. The app refreshes your session quietly, and signs you out after 30 days or when your manager deactivates you.
- **Forgot your password?** Use "Forgot password". The email link works once, within 30 minutes.
- After 5 wrong passwords in a row the account locks for 15 minutes. Ask your manager if you are locked out.
- The top bar shows only the screens your role allows: kitchen staff go straight to **Kitchen**. If you work in several branches, pick the branch at the top right. If a button you need is missing, ask the owner. It is a permission, not a fault.

## Waiter: from seating to serving

1. **Seat the guests.** Open **Tables**, tap a green (free) table, enter the number of guests and tap **Open table**. The table turns amber (occupied) on every screen.
2. **Take the order.** Tap dishes to add them; use the category chips or search. Dishes with sizes or add-ons open a small window: pick Half or Full, add-ons, quantity and a note such as "less spicy", then **Add to order**. Prices come from the menu; you cannot type a price. The total on the right is calculated by the server, with GST.
3. **Fix before sending.** Items marked **Not sent** can be changed with − and +; − on the last one removes it.
4. **Send to the kitchen.** Tap **Send to kitchen**. Each kitchen station gets its own ticket straight away, and the items change to **Sent**.
5. **Add more later.** Add items and tap **Send to kitchen** again. Only the new items go to the kitchen. To remove something the kitchen already has, tap the bin next to it and give a reason; it is recorded with your name.
6. **Serve.** Items change to **Cooking** and **Ready** on your screen as the kitchen works, without reloading. When the food is on the table, tap **Mark served**.
7. **Guests left without ordering?** Open the table and tap **Guests left without ordering: free T…**.
8. **Move, join or split tables** _(screen coming)_: transfer moves the guests to another table, merge joins two tables into one bill, split divides one table's items into separate bills.
9. If someone else changed the same order a moment ago, you will see "This order was changed on another device". The order has already been refreshed; tap again. Nothing is lost.

## Kitchen: the kitchen screen

- Tickets appear in three columns: **New**, **Cooking** and **Ready to serve**, each with the table (or Takeaway/Delivery), the ticket number, add-ons, the waiter's note in red, and a timer. A ticket waiting more than 15 minutes is outlined in red.
- Use the station chips at the top to see only your station.
- Tap **Start cooking** on a ticket, then **Mark ready**. You can also tap a single item to move just that item. When every item of an order is ready, the waiter's screen shows it.
- **Out of something?** Open **Manage → Menu** and switch the dish's **Available** off ("86"); the order screens show it as **Sold out**. It disappears from the order screens in this branch until you turn it back on.
- The top right says **Live** while updates arrive instantly. If the Wi-Fi drops it says **Offline** and the screen refreshes every 10 seconds; on reconnect it catches up and no ticket is skipped.

## Cashier: billing and payment

1. **Bill the order.** Open the table (or the order from **Orders**) and tap **Bill**. Everything must be sent to the kitchen first. The bill:
   - calculates GST (CGST+SGST, or IGST for another state);
   - applies the service charge if your branch uses one;
   - rounds to the rupee;
   - gets its GST invoice number, shown at the top.

   The table shows **Bill pending**. Tapping **Bill** again later shows the same bill; it is never made twice.
2. **Take payment.** Choose Cash, UPI, Card or Wallet, check the amount and tap **Take ₹…**. For UPI or card you can enter the reference. Part payments are allowed: the bill shows what is still to pay, and the amount is filled in for the next payment. The app will not take more than the balance, and a double tap never charges twice.
3. **Cash drawer.** The first cash payment of your shift asks you to open your drawer: count the cash in it, enter the amount and tap **Open drawer**, then take the payment.
4. **Done.** When the bill shows **Paid in full**, tap **Done**. A dine-in table whose food is served is freed automatically; a takeaway screen is cleared for the next customer. If the food is not served yet, the table stays open until the waiter taps **Mark served**.
5. **Print** the invoice with **Print bill** (a PDF opens).
6. **Takeaway and delivery.** On **POS**, pick **Takeaway** or **Delivery**, enter the customer's name and phone (and the address for delivery), add items, send to the kitchen and bill as above. When the customer collects, tap **Handed to customer**.
7. **Business customer?** Enter their GSTIN and name before billing so the invoice shows them as the buyer _(screen coming)_.
8. **Close your drawer** at the end: count the cash and enter it _(screen coming)_. The system shows what it expected and records any difference.

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

Everything is under **Stock** in the top bar.

- **Stock** tab: every ingredient with what is on the shelf; **Low** marks anything below its minimum. Tick **Running low only** to see what to order.
- **New ingredient:** give it a name and whether it is counted in grams, millilitres or pieces. You can still buy and enter it in kg or litres.
- **Stock count:** enter what is actually on the shelf (leave lines empty to skip them). For the very first count, add the cost per kg or litre so stock has a value.
- Tap an ingredient to **add or remove stock** with a reason, record **wastage** (spoilt, spilt, expired), or set its **minimum level**. **History** lists every change.
- **Purchase orders:** **New purchase order**, pick the supplier, then **Add items running low** fills the list. The owner approves it. When the goods arrive, open the order and tap **Receive delivery**; change the price only if the bill differs. Stock goes up at the price paid.
- **Delivery without order** is for goods bought on the spot, such as at the market.
- **Recipes:** pick a dish and list what one portion uses, with a waste % if some is lost in prep. Every sale then takes those amounts out of stock, and you see what a portion costs.
- **Suppliers:** add who you buy from, with phone, GSTIN and how many days you have to pay.

## When something goes wrong

| You see | Means | Do |
|---|---|---|
| "This order was changed on another device" | Someone else edited it first | Refresh and redo your change |
| "Amount is more than the balance" | The bill is already (partly) paid | Refresh the bill and check the balance |
| "No open shift" | Your cash drawer is not open | Open your drawer first |
| "Missing permission" | Your role cannot do this | Ask a manager |
| "Too many requests" | Many tries in a short time | Wait a minute |
| Any other error | Something unexpected | Tell your manager the **reference code** shown with the error. It points the support team to the exact problem. |
