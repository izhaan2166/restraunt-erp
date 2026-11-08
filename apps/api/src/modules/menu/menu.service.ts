import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthPrincipal } from '../auth/principal';
import { resolveBranchPricing } from './pricing';

/**
 * The menu as one branch's POS sees it: active categories and products, with branch prices and
 * availability already resolved. Prices are returned as decimal strings, exactly as stored.
 */
@Injectable()
export class MenuService {
  constructor(private readonly prisma: PrismaService) {}

  async forBranch(actor: AuthPrincipal, branchId: string) {
    const orgId = actor.organizationId;
    const [settings, categories, products, overrides] = await Promise.all([
      this.prisma.branchSettings.findUnique({ where: { branchId }, select: { taxPricingMode: true } }),
      this.prisma.category.findMany({
        where: { organizationId: orgId, deletedAt: null, isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true, parentId: true, sortOrder: true },
      }),
      this.prisma.product.findMany({
        where: { organizationId: orgId, deletedAt: null, isActive: true, category: { deletedAt: null, isActive: true } },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        include: {
          taxRate: { select: { id: true, name: true, rate: true, cgstRate: true, sgstRate: true, igstRate: true, cessRate: true } },
          variants: { orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] },
          modifierGroups: {
            orderBy: { sortOrder: 'asc' },
            include: { group: { include: { modifiers: { where: { isActive: true }, orderBy: { name: 'asc' } } } } },
          },
          comboItems: {
            include: { product: { select: { id: true, name: true } }, variant: { select: { id: true, name: true } } },
          },
        },
      }),
      this.prisma.branchProductPrice.findMany({ where: { branchId } }),
    ]);

    const overridesByProduct = new Map<string, typeof overrides>();
    for (const o of overrides) {
      const list = overridesByProduct.get(o.productId) ?? [];
      list.push(o);
      overridesByProduct.set(o.productId, list);
    }

    const items = products.map((p) => {
      const resolved = resolveBranchPricing(p, p.variants, overridesByProduct.get(p.id) ?? []);
      const variantById = new Map(p.variants.map((v) => [v.id, v]));
      return {
        id: p.id,
        categoryId: p.categoryId,
        sku: p.sku,
        name: p.name,
        description: p.description,
        imageUrl: p.imageUrl,
        isVeg: p.isVeg,
        isCombo: p.isCombo,
        stationCode: p.stationCode,
        hsnSac: p.hsnSac,
        taxRate: p.taxRate,
        price: resolved.price,
        isAvailable: resolved.isAvailable,
        variants: resolved.variants.map((v) => {
          const src = variantById.get(v.id)!;
          return { id: v.id, name: src.name, isDefault: src.isDefault, price: v.price, isAvailable: v.isAvailable };
        }),
        modifierGroups: p.modifierGroups.map((mg) => ({
          id: mg.group.id,
          name: mg.group.name,
          minSelect: mg.group.minSelect,
          maxSelect: mg.group.maxSelect,
          modifiers: mg.group.modifiers.map((m) => ({ id: m.id, name: m.name, price: m.price })),
        })),
        comboItems: p.comboItems.map((c) => ({ product: c.product, variant: c.variant, quantity: c.quantity })),
      };
    });

    return {
      branchId,
      taxPricingMode: settings?.taxPricingMode ?? 'EXCLUSIVE',
      categories,
      products: items,
    };
  }
}
