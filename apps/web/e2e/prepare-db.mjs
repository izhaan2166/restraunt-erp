// Gives the browser tests a fresh database: empty schema, every migration, then the demo
// organisation. Runs as part of starting the test API (Playwright starts web servers before
// any global setup, so this cannot live there).
import { execSync } from 'node:child_process';

const url = process.env.DATABASE_URL;
if (!url || !/_e2e\b|e2e/.test(url)) {
  console.error('prepare-db: DATABASE_URL must point at a dedicated e2e database (its name must contain "e2e").');
  process.exit(1);
}
const env = { ...process.env, SEED_DEMO: 'true' };
const run = (cmd, input) => execSync(cmd, { env, input, stdio: [input ? 'pipe' : 'inherit', 'inherit', 'inherit'] });
// `migrate deploy` creates the database when it does not exist yet, so the wipe always has a target.
run('pnpm exec prisma migrate deploy');
run(`pnpm exec prisma db execute --url "${url}" --stdin`, 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
run('pnpm exec prisma migrate deploy');
run('pnpm db:seed');
