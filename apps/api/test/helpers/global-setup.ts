import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

/** Applies migrations to the test database and syncs reference data once per run. */
export default async function globalSetup(): Promise<void> {
  const url =
    process.env.TEST_DATABASE_URL ?? 'postgresql://ros:ros_dev_password@localhost:5432/restaurant_os_test?schema=public';
  execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    // Imported lazily so ts-jest compiles it with the test config.
    const { seedReferenceData } = await import('../../prisma/seed');
    await seedReferenceData(prisma);
  } finally {
    await prisma.$disconnect();
  }
}
