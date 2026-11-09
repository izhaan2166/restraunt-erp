import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests against the real API and a real PostgreSQL database (nothing is mocked).
 * Starting the test API first rebuilds a dedicated database from the migrations and the demo seed
 * (`e2e/prepare-db.mjs`); the API and this app run on their own ports so a dev setup is left alone.
 *
 * Needs: PostgreSQL reachable at E2E_DATABASE_URL (default: local `restaurant_os_e2e`) and the API
 * built (`pnpm --filter @restaurant-os/api build`).
 */
const API_PORT = Number(process.env.E2E_API_PORT ?? 4100);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3100);
const E2E_DATABASE_URL = process.env.E2E_DATABASE_URL ?? 'postgresql://ros:ros_dev_password@localhost:5432/restaurant_os_e2e?schema=public';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 800 },
  },
  webServer: [
    {
      command: 'node ../web/e2e/prepare-db.mjs && node dist/main.js',
      cwd: '../api',
      port: API_PORT,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'pipe',
      env: {
        NODE_ENV: 'development',
        PORT: String(API_PORT),
        DATABASE_URL: E2E_DATABASE_URL,
        JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET ?? 'e2e-only-secret-0123456789abcdefghijklmnop',
        CORS_ORIGINS: `http://localhost:${WEB_PORT}`,
        LOG_LEVEL: 'warn',
        ...(process.env.REDIS_URL ? { REDIS_URL: process.env.REDIS_URL } : {}),
      },
    },
    {
      // The proxy target is fixed at build time, so the app is built for the test API.
      command: `pnpm exec next build && pnpm exec next start -p ${WEB_PORT}`,
      port: WEB_PORT,
      reuseExistingServer: false,
      timeout: 240_000,
      env: { API_ORIGIN: `http://localhost:${API_PORT}` },
    },
  ],
});
