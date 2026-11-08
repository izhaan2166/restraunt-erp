import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../src/prisma/prisma.service';
import { OrgFixture } from './fixtures';

export interface MenuFixture {
  taxRateId: string;
  paneer: { id: string; half: string; full: string };
  lassi: string;
  thali: string;
  cheese: string;
  dip: string;
  roti: string;
  naan: string;
}

/** A small real menu written straight to the database (menu APIs are covered by menu.e2e). */
export async function seedMenu(prisma: PrismaService, fx: OrgFixture): Promise<MenuFixture> {
  const tag = randomUUID().slice(0, 6).toUpperCase();
  const tax = await prisma.taxRate.create({
    data: { organizationId: fx.orgId, name: 'GST 5%', rate: '5', cgstRate: '2.5', sgstRate: '2.5', igstRate: '5' },
  });
  const cat = await prisma.category.create({ data: { organizationId: fx.orgId, name: `Menu ${tag}` } });
  const addOns = await prisma.modifierGroup.create({
    data: {
      organizationId: fx.orgId,
      name: 'Add-ons',
      minSelect: 0,
      maxSelect: 2,
      modifiers: { create: [{ name: 'Extra cheese', price: '40' }, { name: 'Mint dip', price: '15' }] },
    },
    include: { modifiers: true },
  });
  const bread = await prisma.modifierGroup.create({
    data: {
      organizationId: fx.orgId,
      name: 'Bread',
      minSelect: 1,
      maxSelect: 1,
      modifiers: { create: [{ name: 'Roti', price: '0' }, { name: 'Butter naan', price: '20' }] },
    },
    include: { modifiers: true },
  });
  const common = { organizationId: fx.orgId, categoryId: cat.id, taxRateId: tax.id, hsnSac: '996331' };
  const paneer = await prisma.product.create({
    data: {
      ...common,
      sku: `PNR-${tag}`,
      name: 'Paneer Tikka',
      basePrice: '280',
      stationCode: 'MAIN',
      variants: { create: [{ name: 'Half', price: '180', isDefault: true }, { name: 'Full', price: '320' }] },
      modifierGroups: { create: [{ groupId: addOns.id }] },
    },
    include: { variants: true },
  });
  const lassi = await prisma.product.create({ data: { ...common, sku: `LSI-${tag}`, name: 'Sweet Lassi', basePrice: '90', stationCode: 'BEV' } });
  const thali = await prisma.product.create({
    data: { ...common, sku: `THL-${tag}`, name: 'Veg Thali', basePrice: '250', stationCode: 'MAIN', modifierGroups: { create: [{ groupId: bread.id }] } },
  });
  for (const branchId of [fx.branchA, fx.branchB]) {
    await prisma.kitchenStation.createMany({
      data: [
        { organizationId: fx.orgId, branchId, code: 'MAIN', name: 'Main' },
        { organizationId: fx.orgId, branchId, code: 'BEV', name: 'Beverages' },
      ],
    });
  }
  const mod = (g: typeof addOns, name: string) => g.modifiers.find((m) => m.name === name)!.id;
  return {
    taxRateId: tax.id,
    paneer: { id: paneer.id, half: paneer.variants.find((v) => v.name === 'Half')!.id, full: paneer.variants.find((v) => v.name === 'Full')!.id },
    lassi: lassi.id,
    thali: thali.id,
    cheese: mod(addOns, 'Extra cheese'),
    dip: mod(addOns, 'Mint dip'),
    roti: mod(bread, 'Roti'),
    naan: mod(bread, 'Butter naan'),
  };
}

/** Creates a table in the branch and returns its id. */
export async function addTable(prisma: PrismaService, fx: OrgFixture, branchId: string, label: string) {
  const t = await prisma.restaurantTable.create({ data: { organizationId: fx.orgId, branchId, label, capacity: 4 } });
  return t.id;
}

export const key = () => randomUUID();
