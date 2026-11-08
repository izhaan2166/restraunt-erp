# Cash drawers, expenses and staff – the rules in plain words

## Cash drawers (shifts)

- A cashier **opens a shift** at the start of work by counting the cash already in the drawer (the
  opening balance). Each cashier has at most one open shift per branch.
- While the shift is open, every cash event is written down automatically:
  - a customer pays in cash → the money goes into the drawer of the cashier who took it;
  - a cash refund → the money comes out of the drawer of the person who asked for the refund
    (or, if they have no open shift, the manager who approved it);
  - cash added (change from the bank) or taken out (sent to the safe) → entered with a reason;
  - an expense paid from the drawer (milk, auto fare) → taken out with the expense.
- Nothing can take a drawer below zero.
- By default a branch **cannot take cash without an open shift**, so no cash goes unrecorded. A
  branch can turn this off in its settings (`cashRequiresShift`).
- At the end the cashier **counts the drawer and closes the shift**. The system compares the count
  with what should be there:
  - equal → closed;
  - short or over → a note explaining it is required, the difference is saved, and a
    "Cash short" / "Cash over" notification is raised.
- A closed shift is final. Nobody, not even the owner, can change it or add to it. Mistakes found
  later are fixed in the next shift with a cash movement and a reason.
- The **shift report** shows opening cash, sales, refunds, cash in and out, expenses, expected,
  counted, the difference, and the shift's card/UPI collections. The **summary** adds it all up
  per cashier for any period.

## Expenses

- Every expense has a branch, a category (Electricity, Gas, Repairs…), the amount paid including
  GST (and the GST part if there is a bill), the date, how it was paid, who was paid, and
  optionally the employee it was for.
- A receipt (photo or PDF, up to 5 MB) can be attached. The file is checked to really be an image
  or PDF. Receipts are private: they open only through the app, for people allowed to see the
  expense, and are never reachable by a public link.
- Who can do what by default: managers and accountants record expenses; accountants and owners
  edit them; only owners delete them. Every edit and delete needs a reason.
- Deleting never erases: the expense is hidden, kept with the reason, and its full history (who
  changed what, when, and why) can always be seen.
- If an expense was paid from a cash drawer, editing the amount or deleting it puts the difference
  back through the drawer while that shift is still open. Once the shift is closed, it cannot be
  changed that way.

## Employees and attendance

- An employee profile holds code, name, contact, designation, joining date, salary and branch, and
  can be linked to a login account (which carries their roles). Only people who manage staff see
  salaries.
- Staff **clock in** when they arrive and **clock out** when they leave, once a day (India date).
  A late shift can clock out after midnight.
- If someone forgets to clock out, the system will not close it more than 20 hours later (that
  would record a 30-hour day). A manager enters the right times instead.
- Managers can record a day as present, half day, absent or leave, or correct times. Every
  correction is saved with a reason and the before/after values.
- The attendance report shows per employee: days present, half days, absences, leave, hours worked
  and anyone still clocked in.
- An employee's activity page shows when they logged in and out (and from which device) and what
  they did in the system.
