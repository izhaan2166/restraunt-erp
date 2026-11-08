# Inventory and purchasing rules

How RestaurantOS keeps track of ingredients, what sales take out of stock, and how buying from
suppliers works. All amounts are worked out on the server with exact decimal maths.

## Units

- Every ingredient is kept in its smallest unit: grams (`g`), millilitres (`ml`) or pieces (`pc`).
- Purchases, counts and recipes can use bigger units of the same kind: `kg` (1000 g), `l` (1000 ml),
  `dozen` (12 pc). Mixing kinds (kilograms of eggs counted in pieces) is refused with `UNIT_MISMATCH`.
- Quantities are kept to 3 decimals, cost per base unit to 4 decimals, money to 2 decimals.

## Stock ledger

- Stock is per branch. Every change is a line in the stock ledger (opening, purchase, sale, sale
  reversal, wastage, adjustment in/out) with who did it, why, and the balance after it.
- Ledger lines can never be edited or deleted; mistakes are fixed with a new adjustment.
- The first physical count of an ingredient is its **opening stock**; later counts book only the
  difference.
- Manual outflows (adjustment out, wastage) can never take stock below zero (`INSUFFICIENT_STOCK`).

## Cost

- Each branch keeps a **weighted average cost** per ingredient. A delivery of 4 kg at ₹400/kg on top of
  1 kg at ₹300/kg gives (300 + 1600) ÷ 5 kg = ₹380/kg.
- Purchases are valued at the price **before GST**, since GST paid to suppliers is claimed back as
  input tax credit.
- Sales, wastage and adjustments are valued at the average cost at that moment.
- Stock that went below zero carries no cost, so the next delivery sets the price.

## Recipes

- A recipe lists the ingredients for one product, or for one size of it (half/full plate). A size
  without its own recipe uses the product's recipe; a combo uses the recipes of its items.
- Each line can add a wastage % (peeling, trimming). A recipe can make several portions (`yieldQuantity`).
- With a branch, the recipe shows the estimated cost of one portion.

## When sales take stock

Set per branch (`PATCH /branches/:id/settings`, `stockDeductionPolicy`):

| Policy | Stock is taken | Notes |
|---|---|---|
| `ON_ORDER_COMPLETE` (default) | When the order is completed | Cancelled orders never touch stock |
| `ON_ORDER_CONFIRM` | When items are sent to the kitchen | A voided item goes back to stock unless the kitchen had already started it |
| `NONE` | Never | For branches not tracking stock yet |

- Stock is taken **exactly once** per item, however many times the order is touched. Reopening an
  order or voiding an item puts the stock back; completing again takes it again.
- A refund marked **restock** (with a credit note) returns the credited items' ingredients.
- By default a sale may take stock below zero, so service is never blocked by a missed delivery
  entry; the stock screen shows it as negative. A branch can turn on `allowNegativeStock: false`,
  and then the kitchen will not receive items the stock cannot cover (`INSUFFICIENT_STOCK`).

## Low-stock alerts

- Each branch sets a minimum level per ingredient. When stock falls below it, the branch gets a
  live `inventory.low_stock` event and a notification, once. When stock is back above it,
  `inventory.restocked` is sent.

## Buying from suppliers

1. **Supplier** – name, GSTIN (checked), state, contact, payment terms in days.
2. **Purchase order** – created as a draft with prices and GST rates; totals are worked out by the
   server. Drafts can be edited. An owner (or anyone with `purchases.approve`) approves it, which
   places the order. Numbers look like `BLR1-PO/2627/14`.
3. **Goods received** – each delivery is recorded against the order, and can be partial. Receiving
   more than was ordered is refused. The actual price can differ from the order. Stock and average
   cost update immediately. Goods bought without an order (a market run) can be received directly.
   Numbers look like `BLR1-GRN/2627/31`.
4. **Cancelling** an order cancels only what has not arrived; delivered goods stay in stock.
5. **Supplier bill** – recorded with the supplier's own invoice number (each number once per
   supplier), linked to the deliveries it covers. The due date defaults to the bill date plus the
   supplier's payment terms. A bill with nothing paid can be cancelled.
6. **Payments** – part payments are fine; paying more than is owed is refused. A retried payment
   request (same Idempotency-Key) is recorded once, and parallel payments can never overpay.
7. **Supplier account** – each supplier shows what is owed, what is overdue, and a statement of bills
   and payments with a running balance.

Every change above is written to the audit log.
