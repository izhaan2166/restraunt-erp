import { expect, test } from '@playwright/test';
import { asUser, signIn } from './helpers';

/** Stock and purchasing, as the storekeeper uses them, with the owner approving the order. */

test('storekeeper sets opening stock, sees it running low and records wastage', async ({ page }) => {
  await signIn(page, 'inventory.blr');
  await expect(page).toHaveURL(/\/stock\/levels$/);

  await page.getByRole('button', { name: 'New ingredient' }).click();
  const add = page.getByRole('dialog');
  await add.getByLabel('Name').fill('Basmati Rice');
  await add.getByLabel('Category (optional)').fill('Grains');
  await add.getByLabel('Counted in').selectOption('g');
  await add.getByRole('button', { name: 'Add ingredient' }).click();
  await expect(add).toBeHidden();
  const row = page.getByTestId('stock-row').filter({ hasText: 'Basmati Rice' });
  await expect(row).toContainText('0 g');

  // Opening count: 10 kg at ₹80 a kg.
  await page.getByRole('button', { name: 'Stock count' }).click();
  const count = page.getByRole('dialog');
  await count.getByLabel('Basmati Rice counted').fill('10');
  await count.getByLabel('Basmati Rice unit').selectOption('kg');
  await count.getByLabel('Basmati Rice cost per kg').fill('80');
  await count.getByLabel('Reason').fill('Opening stock');
  await count.getByRole('button', { name: /Save count/ }).click();
  await expect(count).toBeHidden();
  await expect(row).toContainText('10 kg');

  await row.click();
  const item = page.getByRole('dialog');
  await expect(item).toContainText('₹80.00 / kg');
  await item.getByRole('tab', { name: 'Minimum level' }).click();
  await item.getByLabel(/Warn when stock falls below/).fill('15000');
  await item.getByRole('button', { name: 'Save' }).click();
  await expect(item).toBeHidden();
  await expect(row).toContainText('Low');

  await row.click();
  await page.getByRole('dialog').getByRole('tab', { name: 'Wastage' }).click();
  await page.getByRole('dialog').getByLabel('Quantity').fill('500');
  await page.getByRole('dialog').getByLabel('What happened').fill('Got wet in the store');
  await page.getByRole('dialog').getByRole('button', { name: 'Record wastage' }).click();
  await expect(row).toContainText('9.5 kg');

  await page.getByRole('button', { name: 'History' }).click();
  await expect(page.getByTestId('movement').first()).toContainText('Wastage');
  await expect(page.getByTestId('movement').first()).toContainText('-500 g');
});

test('storekeeper orders what is running low, the owner approves, and the delivery adds stock', async ({ browser }) => {
  const store = await asUser(browser, 'inventory.blr');
  await store.goto('/stock/suppliers');
  await store.getByRole('button', { name: 'Add supplier' }).click();
  const sup = store.getByRole('dialog');
  await sup.getByLabel('Name').fill('Annapurna Grains');
  await sup.getByLabel('Phone (optional)').fill('9876500011');
  await sup.getByLabel('Pay within (days)').fill('15');
  await sup.getByRole('button', { name: 'Add supplier' }).click();
  await expect(store.getByTestId('supplier-row').filter({ hasText: 'Annapurna Grains' })).toContainText('Pay in 15 days');

  await store.goto('/stock/purchases');
  await store.getByRole('button', { name: 'New purchase order' }).click();
  const form = store.getByRole('dialog');
  await form.getByLabel('Supplier').selectOption({ label: 'Annapurna Grains' });
  await form.getByRole('button', { name: /running low/ }).click();
  const line = form.getByTestId('po-line').filter({ has: store.getByRole('option', { name: 'Basmati Rice', selected: true }) });
  await expect(line).toHaveCount(1);
  await line.getByLabel('Quantity').fill('20');
  await expect(line.getByLabel('Unit')).toHaveValue('kg');
  await line.getByLabel('₹ per kg').fill('80');
  await line.getByLabel('GST %').fill('5');
  await form.getByRole('button', { name: 'Save purchase order' }).click();
  // Totals come from the server: 20 × ₹80 = ₹1,600 + 5% GST.
  const po = store.getByRole('dialog');
  await expect(po).toContainText('₹1,680.00');
  await expect(po).toContainText('waiting for the owner to approve');
  await po.getByRole('button', { name: 'Close' }).last().click();

  const owner = await asUser(browser, 'owner');
  await owner.goto('/stock/purchases');
  // The owner works across branches; the order was raised in Indiranagar.
  await owner.getByTestId('branch-switcher').selectOption({ label: 'Demo Indiranagar' });
  await owner.getByTestId('po-row').filter({ hasText: 'Annapurna Grains' }).click();
  await owner.getByRole('dialog').getByRole('button', { name: 'Approve order' }).click();
  await expect(owner.getByRole('dialog')).toContainText('Ordered');

  await store.reload();
  await store.getByTestId('po-row').filter({ hasText: 'Annapurna Grains' }).click();
  const receive = store.getByRole('dialog');
  await receive.getByRole('button', { name: 'Receive delivery' }).click();
  await expect(receive.getByLabel('Basmati Rice arrived')).toHaveValue('20');
  await receive.getByRole('button', { name: 'Add to stock' }).click();
  await expect(receive).toContainText('Received');
  await expect(receive).toContainText(/GRN/);
  await receive.getByRole('button', { name: 'Close' }).last().click();

  await store.goto('/stock/levels');
  const row = store.getByTestId('stock-row').filter({ hasText: 'Basmati Rice' });
  await expect(row).toContainText('29.5 kg');
  await expect(row).not.toContainText('Low');
});

test('storekeeper sets a recipe and sees what a portion costs', async ({ page }) => {
  await signIn(page, 'inventory.blr');
  await page.goto('/stock/recipes');
  await page.getByRole('list', { name: 'Dishes' }).getByRole('button', { name: /Gulab Jamun/ }).click();
  await page.getByRole('button', { name: 'Add ingredient' }).click();
  const line = page.getByTestId('recipe-line');
  await line.getByLabel('Ingredient').selectOption({ label: 'Basmati Rice' });
  await line.getByLabel('Amount').fill('100');
  await line.getByLabel('Waste %').fill('10');
  await page.getByRole('button', { name: 'Save recipe' }).click();
  // 110 g at ₹80/kg ≈ ₹8.80, worked out by the server.
  await expect(page.getByText(/cost about ₹8\.80 a portion/)).toBeVisible();
  await expect(page.getByText(/takes 110 g Basmati Rice out of stock/)).toBeVisible();
});
