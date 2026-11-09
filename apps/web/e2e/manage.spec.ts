import { expect, test } from '@playwright/test';
import { asUser, signIn } from './helpers';

/** Owner and manager screens, each change checked where staff actually see it (POS, sign-in, floor). */

test('owner adds a dish with two sizes and the cashier can sell the large one', async ({ browser }) => {
  const owner = await asUser(browser, 'owner');
  await owner.goto('/manage/menu');
  await owner.getByRole('button', { name: 'New dish' }).click();
  const editor = owner.getByRole('dialog');
  await editor.getByLabel('Dish name').fill('Mango Shake');
  await editor.getByLabel('Category').selectOption({ label: 'Beverages' });
  await editor.getByLabel('Price (₹)').first().fill('120');
  await editor.getByRole('button', { name: 'Add size' }).click();
  await editor.getByRole('button', { name: 'Add size' }).click();
  await editor.getByLabel('Size').nth(0).fill('Regular');
  await editor.getByLabel('Price (₹)').nth(1).fill('120');
  await editor.getByLabel('Size').nth(1).fill('Large');
  await editor.getByLabel('Price (₹)').nth(2).fill('160');
  await editor.getByRole('button', { name: 'Add dish' }).click();
  await expect(editor).toBeHidden();
  await expect(owner.getByText('Mango Shake')).toBeVisible();
  await expect(owner.getByText(/Regular ₹120.*Large ₹160/)).toBeVisible();

  const cashier = await asUser(browser, 'cashier.blr');
  await cashier.goto('/pos');
  await cashier.getByRole('tab', { name: 'Beverages' }).click();
  await cashier.getByRole('button', { name: /Mango Shake/ }).click();
  const pick = cashier.getByRole('dialog');
  await pick.getByRole('radio', { name: /Large/ }).click();
  await pick.getByRole('button', { name: 'Add to order' }).click();
  await expect(cashier.getByTestId('order-item')).toContainText('Large');
});

test('kitchen marks a dish sold out and the cashier cannot add it', async ({ browser }) => {
  const kitchen = await asUser(browser, 'kitchen.blr');
  await kitchen.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Manage' }).click();
  await expect(kitchen).toHaveURL(/\/manage\/menu$/);
  // Kitchen staff can switch dishes on and off but not edit them.
  await expect(kitchen.getByRole('button', { name: 'New dish' })).toHaveCount(0);
  await expect(kitchen.getByRole('button', { name: /^Edit / })).toHaveCount(0);
  const jamun = kitchen.getByRole('switch', { name: /Gulab Jamun .* available/ });
  await jamun.uncheck();
  await expect(jamun).not.toBeChecked();

  const cashier = await asUser(browser, 'cashier.blr');
  await cashier.goto('/pos');
  await cashier.getByRole('tab', { name: 'Desserts' }).click();
  const tile = cashier.getByRole('button', { name: /Gulab Jamun/ });
  await expect(tile).toBeDisabled();
  await expect(tile).toContainText('Sold out');

  // Back on, so the dish is sellable again.
  await kitchen.reload();
  await kitchen.getByRole('switch', { name: /Gulab Jamun .* available/ }).check();
  await expect(kitchen.getByRole('switch', { name: /Gulab Jamun .* available/ })).toBeChecked();
});

test('a manager adds a waiter who can then sign in', async ({ browser }) => {
  const manager = await asUser(browser, 'manager.blr');
  await manager.goto('/manage/staff');
  await manager.getByRole('button', { name: 'Add staff' }).click();
  const form = manager.getByRole('dialog');
  await form.getByLabel('Full name').fill('Ravi Kumar');
  await form.getByLabel('Work email').fill('ravi.e2e@demo.restaurantos.local');
  await form.getByLabel('First password').fill('Welcome2026x');
  await form.getByLabel('Role').selectOption({ label: 'Waiter' });
  await form.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(form).toBeHidden();
  await expect(manager.getByTestId('staff-row').filter({ hasText: 'Ravi Kumar' })).toContainText('Waiter');

  const ravi = await asUser(browser, 'ravi.e2e@demo.restaurantos.local', 'Welcome2026x');
  await expect(ravi.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Tables' })).toBeVisible();
});

test('a manager moves a table, saves the layout and adds a new table', async ({ page }) => {
  await signIn(page, 'manager.blr');
  await page.goto('/manage/tables');
  const t3 = page.getByTestId('layout-T3');
  const before = await t3.evaluate((el) => parseInt((el as HTMLElement).style.left, 10));
  await t3.click();
  await t3.press('ArrowRight');
  await t3.press('ArrowRight');
  await expect(t3).toHaveAttribute('aria-label', /moved, not saved/);
  await page.getByRole('button', { name: 'Save layout' }).click();
  await expect(page.getByText('Layout saved')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('layout-T3')).toHaveCSS('left', `${before + 40}px`);

  await page.getByRole('button', { name: 'Add table' }).first().click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('T9');
  await page.getByRole('spinbutton', { name: 'Seats' }).fill('2');
  await page.getByRole('button', { name: 'Add table' }).last().click();
  await expect(page.getByTestId('layout-T9')).toBeVisible();
  await page.goto('/tables');
  await expect(page.getByTestId('table-T9')).toContainText('Free');
});

test('owner opens a new branch, sets how it bills and adds a kitchen station', async ({ page }) => {
  await signIn(page, 'owner');
  await page.goto('/manage/branches');
  await page.getByRole('button', { name: 'New branch' }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('Branch code').fill('BLR-HSR');
  await form.getByLabel('Branch name').fill('Demo HSR Layout');
  await form.getByLabel('State code').fill('29');
  await form.getByLabel('City').fill('Bengaluru');
  await form.getByLabel('Pincode').fill('560102');
  await form.getByRole('button', { name: 'Create branch' }).click();
  await expect(form).toBeHidden();
  await expect(page.getByRole('tablist', { name: 'Branch' }).getByRole('tab', { name: 'Demo HSR Layout', selected: true })).toBeVisible();

  await page.getByLabel('Menu prices').selectOption('INCLUSIVE');
  await page.getByLabel('Service charge %').fill('5');
  await page.getByRole('button', { name: 'Save billing settings' }).click();
  await expect(page.getByText('Billing settings saved')).toBeVisible();

  await page.getByLabel('Short code').fill('TANDOOR');
  await page.getByLabel('Station name').fill('Tandoor');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Tandoor', { exact: true })).toBeVisible();

  await page.reload();
  await page.getByRole('tablist', { name: 'Branch' }).getByRole('tab', { name: 'Demo HSR Layout' }).click();
  await expect(page.getByLabel('Menu prices')).toHaveValue('INCLUSIVE');
  await expect(page.getByLabel('Service charge %')).toHaveValue('5');
});
