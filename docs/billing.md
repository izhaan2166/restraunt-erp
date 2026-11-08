# Billing and GST rules

All money is computed on the server with decimal arithmetic (never floating point) in
`apps/api/src/modules/billing/engine.ts`. Amounts are rounded to the paisa with ROUND_HALF_UP.
The POS shows what the server returns; it never calculates totals itself.

## How a bill is calculated

1. **Line amount** = (unit price + add-on prices) × quantity.
2. **Item discounts** (percentage or fixed) come off that line first.
3. **Order discounts** are applied one after another to what is left, then shared across lines in
   proportion to their amounts. Any leftover paisa goes to the lines with the largest remainders,
   so the shares always add up exactly.
4. **Taxable value** per line:
   - prices exclusive of tax: taxable = net amount;
   - prices inclusive of tax: taxable = net × 100 / (100 + GST rate), and the tax is what remains.
5. **GST** per line:
   - intra-state (normal for a restaurant): CGST = SGST = taxable × rate / 2. With inclusive prices
     the tax is split in two and any odd paisa goes to SGST;
   - inter-state: IGST = taxable × rate.
   Restaurant service is taxed where it is supplied (IGST Act s.12(3)), so invoices use intra-state.
6. **Service charge** (dine-in only, if the branch turns it on) is a percentage of the net amount,
   computed separately for each GST rate on the bill and taxed at that rate (SAC 996331).
7. **Round-off** to the nearest rupee or paisa (branch setting).
   Grand total = taxable + all GST + round-off.

Every invoice line stores its own taxable value and CGST/SGST/IGST, and the invoice stores the
totals and a summary per tax rate, so reports never recalculate history.

## Discount limits

A cashier may give discounts up to the branch's `maxCashierDiscountPct` (default 10% of the
subtotal, counting all discounts on the order). More than that needs `billing.discount.override`.
Every discount needs a reason and is audited.

## Invoices

- Issued final in a single transaction: next invoice number, seller details (legal and trade name, address, GSTIN, PAN, state
  code) copied onto the invoice, buyer GSTIN if given, lines with HSN/SAC.
- Numbers are consecutive per branch per financial year (April–March), e.g. `MAIN/2627/14`.
  The counter is taken inside the same transaction, so a failed request leaves no gap.
- A final invoice cannot be changed; the database rejects updates to its amounts and lines.

## Payments, refunds and credit notes

- An invoice can be paid in several parts and methods (split payment). A payment larger than what
  is still owed is refused. Payments for the same invoice are processed one at a time (row lock),
  so two terminals cannot both take the last balance.
- A **credit note** reduces what the customer owes for chosen lines and quantities, reversing GST
  line by line. A line can never be credited more than it was billed.
- A **refund** returns money against a specific payment (never more than that payment, minus
  earlier refunds). If the person creating it lacks `refunds.approve`, it waits as PENDING until a
  manager approves or rejects it; nobody can approve their own refund.
- **Cancelling an invoice** is allowed only when nothing is paid (refund first). It credits the
  remaining lines and the order can be billed again.

What the invoice shows:

| Field | Meaning |
|---|---|
| `due` | grand total − credit notes (0 once every line is fully credited) |
| `netPaid` | payments − refunds |
| `outstanding` | what the customer still owes |
| `refundDue` | what the restaurant owes the customer |
| `paymentStatus` | UNPAID, PARTIALLY_PAID, PAID, PARTIALLY_REFUNDED or REFUNDED |

A dine-in table shows BILL_PENDING while money is owed and goes back to OCCUPIED once the bill is
settled; staff then close the table.
