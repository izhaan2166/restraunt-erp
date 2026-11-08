/**
 * Seed script.
 *  - Always: permission catalog + units of measure (reference data every install needs).
 *  - When SEED_DEMO=true: a demo organization with two branches, default roles, one user per
 *    role, GST tax rates, kitchen stations and expense categories. Demo data is clearly named
 *    ("Demo …") and is meant for local development and staging only.
 */
import { PrismaClient, UnitDimension } from '@prisma/client';
import * as argon2 from 'argon2';
import { provisionDefaultRoles, syncPermissionCatalog } from '../src/modules/rbac/catalog-sync';

const prisma = new PrismaClient();

const UNITS: { code: string; name: string; dimension: UnitDimension; factorToBase: string }[] = [
  { code: 'g', name: 'Gram', dimension: 'MASS', factorToBase: '1' },
  { code: 'kg', name: 'Kilogram', dimension: 'MASS', factorToBase: '1000' },
  { code: 'ml', name: 'Millilitre', dimension: 'VOLUME', factorToBase: '1' },
  { code: 'l', name: 'Litre', dimension: 'VOLUME', factorToBase: '1000' },
  { code: 'pc', name: 'Piece', dimension: 'COUNT', factorToBase: '1' },
  { code: 'dozen', name: 'Dozen', dimension: 'COUNT', factorToBase: '12' },
];

export async function seedReferenceData(db: PrismaClient): Promise<void> {
  await syncPermissionCatalog(db);
  for (const u of UNITS) {
    await db.unit.upsert({ where: { code: u.code }, create: u, update: { name: u.name, factorToBase: u.factorToBase } });
  }
}

async function seedDemo(db: PrismaClient): Promise<void> {
  const password = process.env.SEED_DEFAULT_PASSWORD ?? 'ChangeMe@2026';
  const existing = await db.user.findUnique({ where: { email: 'admin@demo.restaurantos.local' } });
  if (existing) {
    console.log('Demo organization already present, skipping.');
    return;
  }
  const hash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });

  await db.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: {
        name: 'Demo Spice Route',
        legalName: 'Demo Spice Route Hospitality Pvt Ltd',
        gstin: '29AABCD1234E1Z5',
        pan: 'AABCD1234E',
        stateCode: '29',
        address: '100 Feet Road, Indiranagar, Bengaluru',
        email: 'accounts@demo.restaurantos.local',
      },
    });
    const blr = await tx.branch.create({
      data: { organizationId: org.id, code: 'BLR-IND', name: 'Demo Indiranagar', stateCode: '29', gstin: '29AABCD1234E1Z5', city: 'Bengaluru', pincode: '560038' },
    });
    const mum = await tx.branch.create({
      data: { organizationId: org.id, code: 'MUM-BAN', name: 'Demo Bandra', stateCode: '27', gstin: '27AABCD1234E1Z9', city: 'Mumbai', pincode: '400050' },
    });
    for (const b of [blr, mum]) {
      await tx.branchSettings.create({ data: { branchId: b.id, organizationId: org.id } });
      for (const [code, name] of [['MAIN', 'Main Kitchen'], ['BEV', 'Beverage Counter'], ['DESSERT', 'Dessert Counter']]) {
        await tx.kitchenStation.create({ data: { organizationId: org.id, branchId: b.id, code, name } });
      }
    }
    const roles = await provisionDefaultRoles(tx, org.id);

    const people: [string, string, string, string | null][] = [
      ['admin', 'Demo Super Admin', 'SUPER_ADMIN', null],
      ['owner', 'Demo Owner', 'OWNER', null],
      ['accountant', 'Demo Accountant', 'ACCOUNTANT', null],
      ['manager.blr', 'Demo Manager (Indiranagar)', 'MANAGER', blr.id],
      ['cashier.blr', 'Demo Cashier (Indiranagar)', 'CASHIER', blr.id],
      ['waiter.blr', 'Demo Waiter (Indiranagar)', 'WAITER', blr.id],
      ['kitchen.blr', 'Demo Chef (Indiranagar)', 'KITCHEN_STAFF', blr.id],
      ['inventory.blr', 'Demo Storekeeper (Indiranagar)', 'INVENTORY_MANAGER', blr.id],
      ['manager.mum', 'Demo Manager (Bandra)', 'MANAGER', mum.id],
      ['cashier.mum', 'Demo Cashier (Bandra)', 'CASHIER', mum.id],
    ];
    for (const [handle, fullName, roleKey, branchId] of people) {
      const user = await tx.user.create({
        data: { organizationId: org.id, email: `${handle}@demo.restaurantos.local`, fullName, passwordHash: hash },
      });
      await tx.userRole.create({
        data: { organizationId: org.id, userId: user.id, roleId: roles.get(roleKey)!, branchId },
      });
    }

    // GST on restaurant services: 5% (no ITC) is the common rate; 18% for e.g. specified premises.
    await tx.taxRate.createMany({
      data: [
        { organizationId: org.id, name: 'GST 5% (Restaurant service)', rate: '5', cgstRate: '2.5', sgstRate: '2.5', igstRate: '5' },
        { organizationId: org.id, name: 'GST 18%', rate: '18', cgstRate: '9', sgstRate: '9', igstRate: '18' },
        { organizationId: org.id, name: 'Exempt / Nil', rate: '0', cgstRate: '0', sgstRate: '0', igstRate: '0' },
      ],
    });
    await tx.expenseCategory.createMany({
      data: ['Rent', 'Electricity', 'Salaries', 'Gas', 'Maintenance', 'Miscellaneous'].map((name) => ({
        organizationId: org.id,
        name,
      })),
    });
  });
  console.log(`Demo organization created. Users: <role>@demo.restaurantos.local, password: ${password}`);
}

async function main(): Promise<void> {
  await seedReferenceData(prisma);
  console.log('Reference data synced.');
  if (process.env.SEED_DEMO === 'true') await seedDemo(prisma);
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
