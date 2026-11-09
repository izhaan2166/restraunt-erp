import { Browser, expect, Page } from '@playwright/test';

export const PASSWORD = 'ChangeMe@2026';
export const email = (who: string) => (who.includes('@') ? who : `${who}@demo.restaurantos.local`);

export async function signIn(page: Page, who: string, password = PASSWORD) {
  await page.goto('/login');
  await page.getByLabel('Work email').fill(email(who));
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Wait for the role's home screen, so the next navigation does not race the redirect to it.
  await page.waitForURL((u) => u.pathname !== '/' && !u.pathname.startsWith('/login'));
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

export async function asUser(browser: Browser, who: string, password = PASSWORD) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, who, password);
  return page;
}
