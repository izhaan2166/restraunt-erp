import { expect, test } from '@playwright/test';
import { asUser } from './helpers';

/** The dashboard and reports show the server's figures for a real sale, and exports download. */

test('a sale shows on the dashboard and in the sales report, and the report downloads', async ({ browser }) => {
  const cashier = await asUser(browser, 'cashier.blr');
  await cashier.goto('/pos');
  await cashier.getByLabel('Customer name').fill('Meera');
  await cashier.getByRole('tab', { name: 'Beverages' }).click();
  await cashier.getByRole('button', { name: /Masala Chai/ }).click();
  await cashier.getByRole('button', { name: 'Send to kitchen' }).click();
  await expect(cashier.getByText(/Sent 1 item/)).toBeVisible();
  await cashier.getByRole('button', { name: /^Bill/ }).click();
  const bill = cashier.getByRole('dialog');
  await bill.getByRole('radio', { name: 'UPI' }).click();
  const take = bill.getByRole('button', { name: /^Take/ });
  await expect(take).toHaveText(/₹\d/);
  // The bill total as the server worked it out, e.g. "Take ₹21.00".
  const total = (await take.textContent())!.replace(/^Take\s*/, '').trim();
  await take.click();
  await expect(bill.getByText('Paid in full')).toBeVisible();
  await bill.getByRole('button', { name: 'Done' }).click();

  const owner = await asUser(browser, 'owner');
  await expect(owner).toHaveURL(/\/dashboard$/);
  await owner.getByTestId('branch-switcher').selectOption({ label: 'Demo Indiranagar' });
  await expect(owner.getByTestId('dash-sales')).toHaveText(total);
  await expect(owner.getByRole('list', { name: 'Best sellers' })).toContainText('Masala Chai');
  await expect(owner.getByRole('list', { name: 'Payment methods' })).toContainText('UPI');

  await owner.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Reports' }).click();
  await expect(owner.getByRole('heading', { name: 'Daily sales' })).toBeVisible();
  await expect(owner.getByTestId('total-netBilled')).toHaveText(total);
  await expect(owner.getByTestId('total-invoices')).toHaveText('1');

  await owner.getByRole('navigation', { name: 'Reports' }).getByRole('button', { name: 'Dishes sold' }).click();
  await expect(owner.getByRole('table').first()).toContainText('Masala Chai');

  const download = owner.waitForEvent('download');
  await owner.getByRole('button', { name: 'Excel (CSV)' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^products_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);

  await owner.getByRole('navigation', { name: 'Reports' }).getByRole('button', { name: 'GST' }).click();
  await expect(owner.getByRole('heading', { name: 'GST report' })).toBeVisible();
  const pdf = owner.waitForEvent('download');
  await owner.getByRole('button', { name: 'PDF' }).click();
  expect((await pdf).suggestedFilename()).toMatch(/^gst_.*\.pdf$/);
});

test('a waiter sees neither the dashboard nor reports', async ({ browser }) => {
  const waiter = await asUser(browser, 'waiter.blr');
  const nav = waiter.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: 'Dashboard' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Reports' })).toHaveCount(0);
});
