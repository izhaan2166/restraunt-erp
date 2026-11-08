import { Prisma } from '@prisma/client';

export interface BranchOverride {
  variantId: string | null;
  price: Prisma.Decimal | null;
  isAvailable: boolean;
}

export interface PricedVariant {
  id: string;
  price: Prisma.Decimal;
  isActive: boolean;
}

/**
 * Branch price resolution, in one place so the POS menu and (Phase 3) order pricing agree:
 *  - a variant's price is the branch override for that variant, else the variant's own price;
 *  - a product without variants uses the branch product-level override, else its base price;
 *  - the product-level override (variant_id NULL) also carries the branch's availability for the
 *    whole product; a variant override can additionally switch one variant off.
 */
export function resolveBranchPricing(
  product: { basePrice: Prisma.Decimal; isActive: boolean; isAvailable: boolean },
  variants: PricedVariant[],
  overrides: BranchOverride[],
) {
  const byVariant = new Map(overrides.map((o) => [o.variantId ?? '', o]));
  const productOverride = byVariant.get('');
  const productAvailable = product.isActive && product.isAvailable && (productOverride?.isAvailable ?? true);
  return {
    price: productOverride?.price ?? product.basePrice,
    isAvailable: productAvailable,
    variants: variants
      .filter((v) => v.isActive)
      .map((v) => {
        const o = byVariant.get(v.id);
        return {
          id: v.id,
          price: o?.price ?? v.price,
          isAvailable: productAvailable && (o?.isAvailable ?? true),
        };
      }),
  };
}
