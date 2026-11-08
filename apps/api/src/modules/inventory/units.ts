import { Prisma, UnitDimension } from '@prisma/client';
import { Errors } from '../../common/errors/app-error';

const Dec = Prisma.Decimal;
type D = Prisma.Decimal;

export interface UnitLike {
  id: string;
  code: string;
  dimension: UnitDimension;
  factorToBase: D;
}

/** Stock quantities are kept to 3 decimals (g, ml, pc), costs per base unit to 4. */
export const qty3 = (v: D) => v.toDecimalPlaces(3, Dec.ROUND_HALF_UP);
export const cost4 = (v: D) => v.toDecimalPlaces(4, Dec.ROUND_HALF_UP);
export const money2 = (v: D) => v.toDecimalPlaces(2, Dec.ROUND_HALF_UP);

/**
 * Converts a quantity in `unit` into the ingredient's base unit (kg → g, l → ml, dozen → pc).
 * Units of different dimensions (grams vs. pieces) cannot be converted.
 */
export function toBase(quantity: D, unit: UnitLike, base: UnitLike): D {
  if (unit.dimension !== base.dimension) {
    throw Errors.badRequest('UNIT_MISMATCH', `${unit.code} cannot be converted to ${base.code}`, { unit: unit.code, baseUnit: base.code });
  }
  return quantity.mul(unit.factorToBase).div(base.factorToBase);
}

/** Price per `unit` → price per base unit (₹450 per kg → ₹0.45 per g). */
export function pricePerBase(price: D, unit: UnitLike, base: UnitLike): D {
  return price.mul(base.factorToBase).div(unit.factorToBase);
}

/**
 * Weighted average cost after receiving stock. Stock that is below zero (sold before it was
 * received) carries no cost, so the new average is the price of what arrived.
 */
export function averageCost(onHand: D, currentAvg: D, received: D, unitCost: D): D {
  const held = Dec.max(onHand, 0);
  const total = held.add(received);
  if (total.lte(0)) return cost4(unitCost);
  return cost4(held.mul(currentAvg).add(received.mul(unitCost)).div(total));
}

/** Ingredient amount for `sold` portions of a recipe that makes `yieldQuantity` portions. */
export function recipeUsage(perBatch: D, wastagePercent: D, yieldQuantity: D, sold: D): D {
  return perBatch.mul(new Dec(100).add(wastagePercent)).div(100).div(yieldQuantity).mul(sold);
}
