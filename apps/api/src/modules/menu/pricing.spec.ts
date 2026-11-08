import { Prisma } from '@prisma/client';
import { resolveBranchPricing } from './pricing';

const D = (v: string) => new Prisma.Decimal(v);
const product = { basePrice: D('250.00'), isActive: true, isAvailable: true };
const variants = [
  { id: 'half', price: D('180.00'), isActive: true },
  { id: 'full', price: D('320.00'), isActive: true },
  { id: 'old', price: D('999.00'), isActive: false },
];

describe('resolveBranchPricing', () => {
  it('uses menu prices when the branch has no overrides', () => {
    const r = resolveBranchPricing(product, variants, []);
    expect(r.price.toFixed(2)).toBe('250.00');
    expect(r.isAvailable).toBe(true);
    expect(r.variants.map((v) => [v.id, v.price.toFixed(2), v.isAvailable])).toEqual([
      ['half', '180.00', true],
      ['full', '320.00', true],
    ]);
  });

  it('applies a variant override and leaves other variants alone', () => {
    const r = resolveBranchPricing(product, variants, [{ variantId: 'full', price: D('350.00'), isAvailable: true }]);
    expect(r.variants.find((v) => v.id === 'full')!.price.toFixed(2)).toBe('350.00');
    expect(r.variants.find((v) => v.id === 'half')!.price.toFixed(2)).toBe('180.00');
  });

  it('an availability-only override (price null) keeps the menu price', () => {
    const r = resolveBranchPricing(product, variants, [{ variantId: null, price: null, isAvailable: false }]);
    expect(r.price.toFixed(2)).toBe('250.00');
    expect(r.isAvailable).toBe(false);
    expect(r.variants.every((v) => !v.isAvailable)).toBe(true);
  });

  it('a variant can be switched off on its own', () => {
    const r = resolveBranchPricing(product, variants, [{ variantId: 'half', price: null, isAvailable: false }]);
    expect(r.isAvailable).toBe(true);
    expect(r.variants.find((v) => v.id === 'half')!.isAvailable).toBe(false);
    expect(r.variants.find((v) => v.id === 'full')!.isAvailable).toBe(true);
  });

  it('organization-wide unavailability or an inactive product wins over branch overrides', () => {
    expect(resolveBranchPricing({ ...product, isAvailable: false }, variants, [{ variantId: null, price: null, isAvailable: true }]).isAvailable).toBe(false);
    expect(resolveBranchPricing({ ...product, isActive: false }, variants, []).isAvailable).toBe(false);
  });
});
