import { expect, test } from '@playwright/test';
import { asUser } from './helpers';

/** Cash drawer, expenses and supplier bills, each checked against the figures the server works out. */

test('a cashier opens the drawer, moves cash, closes short with a note and the manager sees it', async ({ browser }) => {
  const cashier = await asUser(browser, 'cashier.mum');
  await cashier.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Money' }).click();
  await expect(cashier).toHaveURL(/\/money\/cash$/);
  await cashier.getByLabel('Cash in drawer now (₹)').fill('1000');
  await cashier.getByRole('button', { name: 'Open drawer' }).click();
  await expect(cashier.getByTestId('expected-cash')).toHaveText('₹1,000.00');

  await cashier.getByRole('button', { name: 'Add cash' }).click();
  let dialog = cashier.getByRole('dialog');
  await dialog.getByLabel('Amount (₹)').fill('500');
  await dialog.getByLabel('Why').fill('Change from the bank');
  await dialog.getByRole('button', { name: 'Add cash' }).click();
  await expect(dialog).toBeHidden();
  await cashier.getByRole('button', { name: 'Take cash out' }).click();
  dialog = cashier.getByRole('dialog');
  await dialog.getByLabel('Amount (₹)').fill('200');
  await dialog.getByLabel('Why').fill('Bank deposit');
  await dialog.getByRole('button', { name: 'Take out' }).click();
  await expect(dialog).toBeHidden();
  await expect(cashier.getByTestId('expected-cash')).toHaveText('₹1,300.00');

  // ₹50 short: the server refuses to close without a note.
  await cashier.getByRole('button', { name: 'Count and close' }).click();
  dialog = cashier.getByRole('dialog');
  await dialog.getByLabel('Cash counted (₹)').fill('1250');
  await dialog.getByRole('button', { name: 'Close shift' }).click();
  await expect(dialog.getByRole('alert')).toContainText('short');
  await dialog.getByLabel('Note (needed if it does not match)').fill('Gave wrong change');
  await dialog.getByRole('button', { name: 'Close shift' }).click();
  await expect(dialog).toBeHidden();
  await expect(cashier.getByText('The drawer is ₹50.00 short')).toBeVisible();
  await expect(cashier.getByRole('button', { name: 'Open drawer' })).toBeVisible();

  const manager = await asUser(browser, 'manager.mum');
  await manager.goto('/money/cash');
  const row = manager.getByTestId('shift-row').filter({ hasText: 'Cashier' });
  await expect(row.first()).toContainText('₹50.00 short');
  await row.first().getByRole('button').first().click();
  const report = manager.getByRole('dialog');
  await expect(report.getByRole('list', { name: 'Drawer entries' })).toContainText('Change from the bank');
  await expect(report).toContainText('Gave wrong change');
});

test('a manager adds an expense with a receipt and the accountant corrects it', async ({ browser }) => {
  const manager = await asUser(browser, 'manager.blr');
  await manager.goto('/money/expenses');
  await manager.getByRole('button', { name: 'Add expense' }).click();
  const form = manager.getByRole('dialog');
  await form.getByLabel('What was it for').fill('Gas cylinder refill');
  await form.getByLabel('Category').selectOption({ label: 'Gas' });
  await form.getByLabel('Amount paid (₹)').fill('1180');
  await form.getByLabel('GST in it (₹, optional)').fill('180');
  await form.getByLabel('Paid by').selectOption('UPI');
  // A tiny real PNG, so the server's file check accepts it.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await form.getByLabel('Receipt file').setInputFiles({ name: 'bill.png', mimeType: 'image/png', buffer: png });
  await form.getByRole('button', { name: 'Add expense' }).click();
  await expect(form).toBeHidden();
  const row = manager.getByTestId('expense-row').filter({ hasText: 'Gas cylinder refill' });
  await expect(row).toContainText('₹1,180.00');
  await expect(row.getByLabel('Has receipt')).toBeVisible();
  await expect(manager.getByTestId('expense-total')).toHaveText('₹1,180.00');

  const accountant = await asUser(browser, 'accountant');
  await accountant.getByTestId('branch-switcher').selectOption({ label: 'Demo Indiranagar' });
  await accountant.goto('/money/expenses');
  await accountant.getByTestId('expense-row').filter({ hasText: 'Gas cylinder refill' }).click();
  const edit = accountant.getByRole('dialog');
  await expect(edit.getByRole('button', { name: 'View receipt' })).toBeVisible();
  await edit.getByLabel('Amount paid (₹)').fill('1080');
  await edit.getByLabel('GST in it (₹, optional)').fill('165');
  await expect(edit.getByRole('button', { name: 'Save' })).toBeDisabled();
  await edit.getByLabel('Why are you changing it').fill('Bill amount corrected');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(edit).toBeHidden();
  await expect(accountant.getByTestId('expense-total')).toHaveText('₹1,080.00');
});

test('the accountant enters a supplier bill, pays part of it and the statement shows what is owed', async ({ browser }) => {
  const store = await asUser(browser, 'inventory.blr');
  await store.goto('/stock/suppliers');
  await store.getByRole('button', { name: 'Add supplier' }).click();
  const sup = store.getByRole('dialog');
  await sup.getByLabel('Name').fill('Konkan Spices');
  await sup.getByLabel('Pay within (days)').fill('30');
  await sup.getByRole('button', { name: 'Add supplier' }).click();
  await expect(sup).toBeHidden();

  const accountant = await asUser(browser, 'accountant');
  await accountant.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Money' }).click();
  await accountant.getByRole('navigation', { name: 'Money' }).getByRole('link', { name: 'Supplier bills' }).click();
  await accountant.getByRole('button', { name: 'Add bill' }).click();
  const form = accountant.getByRole('dialog');
  await form.getByLabel('Supplier').selectOption({ label: 'Konkan Spices' });
  await form.getByLabel('Bill number').fill('KS-2041');
  await form.getByLabel('Amount before GST (₹)').fill('4000');
  await form.getByLabel('GST (₹)', { exact: true }).fill('200');
  await form.getByRole('button', { name: 'Add bill' }).click();

  // The new bill opens: total and owed come from the server.
  const bill = accountant.getByRole('dialog');
  await expect(bill.getByTestId('bill-outstanding')).toHaveText('₹4,200.00');
  await bill.getByLabel('Amount (₹)').fill('1500');
  await bill.getByLabel('Reference (optional)').fill('NEFT 99812');
  await bill.getByRole('button', { name: 'Record payment' }).click();
  await expect(bill.getByTestId('bill-outstanding')).toHaveText('₹2,700.00');
  await expect(bill.getByRole('list', { name: 'Payments' })).toContainText('NEFT 99812');
  await bill.getByRole('button', { name: 'Close' }).last().click();

  await expect(accountant.getByTestId('bill-row').filter({ hasText: 'KS-2041' })).toContainText('Part paid');
  await accountant.getByLabel('Supplier').selectOption({ label: 'Konkan Spices' });
  await accountant.getByRole('button', { name: 'Statement' }).click();
  await expect(accountant.getByRole('dialog')).toContainText('Owed now ₹2,700.00');
});
