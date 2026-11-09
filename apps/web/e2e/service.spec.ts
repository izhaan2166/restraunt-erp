import { expect, test } from '@playwright/test';
import { asUser, email, PASSWORD, signIn } from './helpers';

test.describe('sign-in', () => {
  test('a wrong password is refused with a plain message', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Work email').fill(email('waiter.blr'));
    await page.getByLabel('Password').fill('not-the-password-1');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('a signed-out visit goes to sign-in and comes back afterwards', async ({ page }) => {
    await page.goto('/tables');
    await expect(page).toHaveURL(/\/login\?next=%2Ftables/);
    await page.getByLabel('Work email').fill(email('waiter.blr'));
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/tables$/);
    await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
  });

  test('the session survives a page reload (refresh cookie, token kept in memory only)', async ({ page }) => {
    await signIn(page, 'cashier.blr');
    await page.goto('/orders');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Orders' })).toBeVisible();
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('eyJ');
  });

  test('kitchen staff see the kitchen screen and only the menu switches', async ({ page }) => {
    await signIn(page, 'kitchen.blr');
    await expect(page).toHaveURL(/\/kitchen$/);
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link')).toHaveText(['Kitchen', 'Manage']);
  });
});

test('dine-in: waiter orders, kitchen cooks live, cashier takes cash and the table is freed', async ({ browser }) => {
  // Waiter seats two guests at T4 and orders.
  const waiter = await asUser(browser, 'waiter.blr');
  await waiter.goto('/tables');
  await waiter.getByTestId('table-T4').click();
  await waiter.getByLabel('Guests').fill('2');
  await waiter.getByRole('button', { name: 'Open table' }).click();
  await expect(waiter.getByRole('heading', { name: 'Table T4' })).toBeVisible();

  await waiter.getByRole('button', { name: /Sweet Lassi/ }).click();
  await expect(waiter.getByTestId('order-item')).toHaveCount(1);
  await waiter.getByRole('button', { name: /Butter Chicken/ }).click();
  await waiter.getByRole('radio', { name: /Full/ }).click();
  await waiter.getByLabel('Note for the kitchen').fill('Less spicy');
  await waiter.getByRole('button', { name: 'Add to order' }).click();
  await expect(waiter.getByTestId('order-item')).toHaveCount(2);
  await waiter.getByRole('button', { name: 'One more Sweet Lassi' }).click();
  // Totals are the server's: 2 × 90 + 380 = 560, plus 5% GST = 588.
  await expect(waiter.getByTestId('grand-total')).toHaveText('₹588.00');
  await expect(waiter.getByRole('button', { name: /^Bill/ })).toBeDisabled();

  // The kitchen board is open before the order is sent, so the ticket must arrive live.
  const kitchen = await asUser(browser, 'kitchen.blr');
  await expect(kitchen.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
  const before = await kitchen.getByRole('article', { name: /Table T4/ }).count();
  expect(before).toBe(0);

  await waiter.getByRole('button', { name: 'Send to kitchen' }).click();
  await expect(waiter.getByText('Sent 2 items to the kitchen')).toBeVisible();
  await expect(waiter.getByTestId('order-item').first()).toContainText('Sent');

  const t4 = kitchen.getByRole('article', { name: /Table T4/ });
  await expect(t4).toHaveCount(2, { timeout: 5_000 }); // drinks and mains go to different stations
  await expect(kitchen.getByText('Less spicy')).toBeVisible();
  for (let i = 0; i < 2; i++) {
    await kitchen.getByTestId('column-PENDING').getByRole('article', { name: /Table T4/ }).first().getByRole('button', { name: 'Start cooking', exact: true }).click();
  }
  await expect(kitchen.getByTestId('column-PREPARING').getByRole('article', { name: /Table T4/ })).toHaveCount(2);
  for (let i = 0; i < 2; i++) {
    await kitchen.getByTestId('column-PREPARING').getByRole('article', { name: /Table T4/ }).first().getByRole('button', { name: 'Mark ready', exact: true }).click();
  }
  await expect(kitchen.getByTestId('column-READY').getByRole('article', { name: /Table T4/ })).toHaveCount(2);

  // The waiter's screen follows the kitchen without a reload.
  await expect(waiter.getByTestId('order-item').filter({ hasText: 'Ready' })).toHaveCount(2);
  await waiter.getByRole('button', { name: 'Mark served' }).click();
  await expect(waiter.getByText(/· Served$/)).toBeVisible();

  // Cashier bills the table. Cash needs an open drawer, which the bill screen asks for.
  const cashier = await asUser(browser, 'cashier.blr');
  await cashier.goto('/tables');
  await cashier.getByTestId('table-T4').click();
  await cashier.getByRole('button', { name: /^Bill/ }).click();
  const bill = cashier.getByRole('dialog');
  await expect(bill.getByRole('heading', { name: /^Bill BLR-IND\// })).toBeVisible();
  await expect(bill).toContainText('CGST');
  await expect(bill).toContainText('₹588.00');
  await bill.getByLabel('Amount (₹)').fill('500');
  await bill.getByRole('button', { name: 'Take ₹500.00' }).click();
  await expect(bill.getByText('Open your cash drawer')).toBeVisible();
  await bill.getByLabel('Cash in drawer (₹)').fill('2000');
  await bill.getByRole('button', { name: 'Open drawer' }).click();
  await bill.getByRole('button', { name: 'Take ₹500.00' }).click();
  await expect(bill).toContainText('Still to pay');
  await expect(bill.getByLabel('Amount (₹)')).toHaveValue('88');
  await bill.getByRole('radio', { name: 'UPI' }).click();
  await bill.getByLabel('UPI reference').fill('RRN123456');
  await bill.getByRole('button', { name: 'Take ₹88.00' }).click();
  await expect(bill.getByText('Paid in full')).toBeVisible();
  await bill.getByRole('button', { name: 'Done' }).click();

  await expect(cashier).toHaveURL(/\/tables$/);
  await expect(cashier.getByTestId('table-T4')).toContainText('Free');
  await cashier.goto('/orders');
  await cashier.getByRole('tab', { name: 'Completed' }).click();
  await expect(cashier.getByRole('link', { name: /Table T4/ })).toBeVisible();
});

test('takeaway: cashier rings up and takes UPI, and the screen is ready for the next customer', async ({ page }) => {
  await signIn(page, 'cashier.blr');
  await page.goto('/pos');
  await expect(page.getByRole('tab', { name: 'Takeaway', selected: true })).toBeVisible();
  await page.getByLabel('Customer name').fill('Asha');
  await page.getByRole('tab', { name: 'Beverages' }).click();
  await page.getByRole('button', { name: /Masala Chai/ }).click();
  await page.getByRole('button', { name: /Masala Chai/ }).click();
  await expect(page.getByTestId('order-item')).toHaveCount(2);
  await page.getByRole('button', { name: 'Send to kitchen' }).click();
  await expect(page.getByText(/Sent 2 items/)).toBeVisible();
  await page.getByRole('button', { name: /^Bill/ }).click();
  const bill = page.getByRole('dialog');
  await bill.getByRole('radio', { name: 'UPI' }).click();
  await bill.getByRole('button', { name: /^Take/ }).click();
  await expect(bill.getByText('Paid in full')).toBeVisible();
  await bill.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('heading', { name: 'New order' })).toBeVisible();
  await expect(page.getByTestId('order-item')).toHaveCount(0);
});

test('a waiter cannot bill; seating and freeing a table without an order works', async ({ browser }) => {
  const waiter = await asUser(browser, 'waiter.blr');
  await waiter.goto('/tables');
  await waiter.getByTestId('table-T5').click();
  await waiter.getByRole('button', { name: 'Open table' }).click();
  await waiter.getByRole('button', { name: /Dal Makhani/ }).click();
  await waiter.getByRole('checkbox', { name: /Extra butter/ }).click();
  await waiter.getByRole('button', { name: 'Add to order' }).click();
  await expect(waiter.getByTestId('order-item')).toContainText('Extra butter');
  await waiter.getByRole('button', { name: 'Send to kitchen' }).click();
  await expect(waiter.getByText(/Sent 1 item/)).toBeVisible();
  await expect(waiter.getByRole('button', { name: /^Bill/ })).toBeDisabled();

  // P1: guests sat down and left; the table goes back to free.
  await waiter.goto('/tables');
  await waiter.getByTestId('table-P1').click();
  await waiter.getByRole('button', { name: 'Open table' }).click();
  await waiter.getByRole('button', { name: /free P1/ }).click();
  await expect(waiter).toHaveURL(/\/tables$/);
  await expect(waiter.getByTestId('table-P1')).toContainText('Free');
  await expect(waiter.getByTestId('table-T5')).toContainText('since');
});
