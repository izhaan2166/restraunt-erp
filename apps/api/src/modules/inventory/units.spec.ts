import { Prisma } from '@prisma/client';
import { averageCost, pricePerBase, qty3, recipeUsage, toBase } from './units';

const D = (v: string | number) => new Prisma.Decimal(v);
const g = { id: 'g', code: 'g', dimension: 'MASS' as const, factorToBase: D(1) };
const kg = { id: 'kg', code: 'kg', dimension: 'MASS' as const, factorToBase: D(1000) };
const pc = { id: 'pc', code: 'pc', dimension: 'COUNT' as const, factorToBase: D(1) };
const dozen = { id: 'dz', code: 'dozen', dimension: 'COUNT' as const, factorToBase: D(12) };

describe('units and costing', () => {
  it('converts within a dimension', () => {
    expect(toBase(D('2.5'), kg, g).toString()).toBe('2500');
    expect(toBase(D('150'), g, g).toString()).toBe('150');
    expect(toBase(D('2'), dozen, pc).toString()).toBe('24');
    expect(toBase(D('500'), g, kg).toString()).toBe('0.5');
  });

  it('refuses to convert between dimensions', () => {
    expect(() => toBase(D(1), kg, pc)).toThrow(/cannot be converted/);
  });

  it('turns a purchase price into a price per base unit', () => {
    expect(pricePerBase(D('450'), kg, g).toString()).toBe('0.45');
    expect(pricePerBase(D('60'), dozen, pc).toString()).toBe('5');
  });

  it('keeps a weighted average cost', () => {
    // 1000 g at ₹0.40 + 1000 g at ₹0.50 → ₹0.45
    expect(averageCost(D(1000), D('0.4'), D(1000), D('0.5')).toString()).toBe('0.45');
    // Nothing on hand (or negative): the new price wins.
    expect(averageCost(D(0), D('0.4'), D(500), D('0.6')).toString()).toBe('0.6');
    expect(averageCost(D(-200), D('0.4'), D(500), D('0.6')).toString()).toBe('0.6');
    expect(averageCost(D(3), D('1'), D(3), D('2')).toString()).toBe('1.5');
  });

  it('scales recipe quantities by wastage, yield and portions sold', () => {
    // 150 g chicken + 10% trim, recipe makes 1 portion, 2 sold → 330 g
    expect(recipeUsage(D(150), D(10), D(1), D(2)).toString()).toBe('330');
    // A 4-portion batch using 1000 g, one portion sold → 250 g
    expect(recipeUsage(D(1000), D(0), D(4), D(1)).toString()).toBe('250');
    expect(qty3(recipeUsage(D(100), D(0), D(3), D(1))).toString()).toBe('33.333');
  });
});
