import { expect, test } from '@playwright/test';
import { asUser } from './helpers';

/** Employee records, clocking in from the top bar, and a manager recording leave. */

test('a manager adds employees, the waiter clocks in and the manager records leave', async ({ browser }) => {
  const manager = await asUser(browser, 'manager.blr');
  await manager.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Team' }).click();
  await expect(manager).toHaveURL(/\/team\/attendance$/);
  await manager.getByRole('navigation', { name: 'Team' }).getByRole('link', { name: 'Employees' }).click();

  await manager.getByRole('button', { name: 'Add employee' }).click();
  let form = manager.getByRole('dialog');
  await form.getByLabel('Employee code').fill('E-201');
  await form.getByLabel('Full name').fill('Suresh Naik');
  await form.getByLabel('Job (optional)').fill('Captain');
  await form.getByLabel('Monthly salary (₹, optional)').fill('18000');
  await form.getByLabel('Their sign-in (optional)').selectOption({ label: 'Demo Waiter (Indiranagar) (waiter.blr@demo.restaurantos.local)' });
  await form.getByRole('button', { name: 'Add employee' }).click();
  await expect(form).toBeHidden();
  await expect(manager.getByTestId('employee-row').filter({ hasText: 'Suresh Naik' })).toContainText('Can sign in');

  await manager.getByRole('button', { name: 'Add employee' }).click();
  form = manager.getByRole('dialog');
  await form.getByLabel('Employee code').fill('E-202');
  await form.getByLabel('Full name').fill('Lakshmi Rao');
  await form.getByRole('button', { name: 'Add employee' }).click();
  await expect(form).toBeHidden();

  const waiter = await asUser(browser, 'waiter.blr');
  await waiter.getByRole('button', { name: 'Clock in' }).click();
  await expect(waiter.getByRole('button', { name: /Clock out/ })).toBeVisible();

  await manager.getByRole('navigation', { name: 'Team' }).getByRole('link', { name: 'Attendance' }).click();
  await expect(manager.getByTestId('attendance-row').filter({ hasText: 'Suresh Naik' })).toContainText('Present');
  await manager.getByRole('button', { name: 'Record Lakshmi Rao' }).click();
  const rec = manager.getByRole('dialog');
  await rec.getByLabel('Status').selectOption('LEAVE');
  await rec.getByLabel('Why').fill('Family function');
  await rec.getByRole('button', { name: 'Save' }).click();
  await expect(rec).toBeHidden();
  await expect(manager.getByTestId('attendance-row').filter({ hasText: 'Lakshmi Rao' })).toContainText('On leave');
  await expect(manager.getByRole('table')).toContainText('Lakshmi Rao');

  await waiter.getByRole('button', { name: /Clock out/ }).click();
  await expect(waiter.getByRole('button', { name: 'Clock in' })).toBeVisible();
});
