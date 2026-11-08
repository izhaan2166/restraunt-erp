import { Prisma } from '@prisma/client';
import { Errors } from '../../common/errors/app-error';
import type { AuthPrincipal } from '../auth/principal';
import { computeBill, DiscountInput, money } from '../billing/engine';
import { resolveBranchPricing } from '../menu/pricing';
import { OrderItemInputDto } from './dto/orders.dto';

type Tx = Prisma.TransactionClient;
const Dec = Prisma.Decimal;

export interface BranchBilling {
  branchId: string;
  stateCode: string;
  taxPricingMode: 'INCLUSIVE' | 'EXCLUSIVE';
  roundingMode: 'NEAREST_RUPEE' | 'NEAREST_PAISA';
  serviceChargePercent: Prisma.Decimal;
  maxCashierDiscountPct: Prisma.Decimal;
  invoicePrefix: string;
}

/** Branch billing settings, with the schema defaults when a branch has no settings row yet. */
export async function branchBilling(db: Tx, organizationId: string, branchId: string): Promise<BranchBilling> {
  const b = await db.branch.findFirst({ where: { id: branchId, organizationId }, include: { settings: true } });
  if (!b) throw Errors.notFound('Branch');
  return {
    branchId,
    stateCode: b.stateCode,
    taxPricingMode: b.settings?.taxPricingMode ?? 'EXCLUSIVE',
    roundingMode: b.settings?.roundingMode ?? 'NEAREST_RUPEE',
    serviceChargePercent: b.settings?.serviceChargePercent ?? new Dec(0),
    maxCashierDiscountPct: b.settings?.maxCashierDiscountPct ?? new Dec(10),
    invoicePrefix: b.settings?.invoicePrefix ?? b.code.slice(0, 10),
  };
}

/**
 * Turns POS input into order-item rows with price and tax snapshots taken from the live menu
 * (branch price, availability, add-on rules). Amount columns are filled by `recomputeOrder`.
 */
export async function buildItems(tx: Tx, actor: AuthPrincipal, settings: BranchBilling, items: OrderItemInputDto[]) {
  const productIds = [...new Set(items.map((i) => i.productId))];
  const [products, overrides] = await Promise.all([
    tx.product.findMany({
      where: { id: { in: productIds }, organizationId: actor.organizationId, deletedAt: null },
      include: {
        taxRate: true,
        variants: true,
        modifierGroups: { include: { group: { include: { modifiers: true } } } },
      },
    }),
    tx.branchProductPrice.findMany({ where: { branchId: settings.branchId, productId: { in: productIds } } }),
  ]);
  const byId = new Map(products.map((p) => [p.id, p]));
  const canOverride = actor.permissions.has('billing.price.override', settings.branchId);

  return items.map((input, idx) => {
    const p = byId.get(input.productId);
    const where = { item: idx, productId: input.productId };
    if (!p || !p.isActive) throw Errors.badRequest('INVALID_PRODUCT', 'Product not found or inactive', where);
    const resolved = resolveBranchPricing(p, p.variants, overrides.filter((o) => o.productId === p.id));
    const activeVariants = p.variants.filter((v) => v.isActive);

    let variant: (typeof p.variants)[number] | undefined;
    let price = resolved.price;
    let available = resolved.isAvailable;
    if (activeVariants.length) {
      if (!input.variantId) throw Errors.badRequest('VARIANT_REQUIRED', `Choose a size/variant for "${p.name}"`, where);
      const rv = resolved.variants.find((v) => v.id === input.variantId);
      variant = activeVariants.find((v) => v.id === input.variantId);
      if (!rv || !variant) throw Errors.badRequest('INVALID_VARIANT', `Variant not found for "${p.name}"`, where);
      price = rv.price;
      available = rv.isAvailable;
    } else if (input.variantId) {
      throw Errors.badRequest('INVALID_VARIANT', `"${p.name}" has no variants`, where);
    }
    if (!available) throw Errors.conflict('ITEM_UNAVAILABLE', `"${p.name}" is not available right now`, where);

    if (input.unitPriceOverride !== undefined) {
      if (!canOverride) {
        throw Errors.forbidden('MISSING_PERMISSION', 'Overriding an item price requires billing.price.override', {
          missing: ['billing.price.override'],
          branchId: settings.branchId,
        });
      }
      if (!input.overrideReason) throw Errors.badRequest('REASON_REQUIRED', 'overrideReason is required with unitPriceOverride', where);
      price = new Dec(input.unitPriceOverride);
    }

    // Add-ons: must belong to a group linked to the product and respect min/max per group.
    const groups = p.modifierGroups.map((g) => g.group);
    const chosen = input.modifiers ?? [];
    const seen = new Set<string>();
    const modifierRows = chosen.map((m) => {
      if (seen.has(m.modifierId)) throw Errors.badRequest('DUPLICATE_MODIFIER', 'An add-on is listed twice; use quantity', where);
      seen.add(m.modifierId);
      const group = groups.find((g) => g.modifiers.some((x) => x.id === m.modifierId));
      const mod = group?.modifiers.find((x) => x.id === m.modifierId);
      if (!group || !mod || !mod.isActive) throw Errors.badRequest('INVALID_MODIFIER', `Add-on not available for "${p.name}"`, where);
      return { groupId: group.id, modifierId: mod.id, name: mod.name, price: mod.price, quantity: m.quantity ?? 1 };
    });
    for (const g of groups) {
      const count = modifierRows.filter((r) => r.groupId === g.id).length;
      if (count < g.minSelect || count > g.maxSelect) {
        throw Errors.badRequest(
          'INVALID_MODIFIER_SELECTION',
          `"${g.name}" needs ${g.minSelect === g.maxSelect ? g.minSelect : `${g.minSelect}–${g.maxSelect}`} choice(s) for "${p.name}"`,
          { ...where, groupId: g.id, chosen: count },
        );
      }
    }

    return {
      productId: p.id,
      variantId: variant?.id ?? null,
      productName: p.name,
      variantName: variant?.name ?? null,
      hsnSac: p.hsnSac,
      stationCode: p.stationCode,
      quantity: new Dec(input.quantity),
      unitPrice: price,
      priceIncludesTax: settings.taxPricingMode === 'INCLUSIVE',
      taxRate: p.taxRate?.rate ?? new Dec(0),
      specialInstructions: input.instructions?.trim() || null,
      modifiers: modifierRows.map(({ groupId: _g, ...m }) => m),
      priceOverride: input.unitPriceOverride !== undefined ? { reason: input.overrideReason!, menuPrice: resolved.price } : null,
    };
  });
}

export type BuiltItem = ReturnType<typeof buildItems> extends Promise<infer T> ? T extends (infer U)[] ? U : never : never;

export async function insertItems(tx: Tx, orderId: string, actorId: string, items: BuiltItem[]) {
  const ids: string[] = [];
  for (const it of items) {
    const modifiersTotal = money(it.modifiers.reduce((a, m) => a.add(new Dec(m.price).mul(m.quantity)), new Dec(0)).mul(it.quantity));
    const lineSubtotal = money(it.unitPrice.mul(it.quantity)).add(modifiersTotal);
    const row = await tx.orderItem.create({
      data: {
        orderId,
        productId: it.productId,
        variantId: it.variantId,
        productName: it.productName,
        variantName: it.variantName,
        hsnSac: it.hsnSac,
        stationCode: it.stationCode,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        modifiersTotal,
        priceIncludesTax: it.priceIncludesTax,
        taxRate: it.taxRate,
        // Placeholder amounts; recomputeOrder() fills the real ones in the same transaction.
        lineSubtotal,
        taxableAmount: 0,
        taxAmount: 0,
        lineTotal: 0,
        specialInstructions: it.specialInstructions,
        createdById: actorId,
        modifiers: { create: it.modifiers.map((m) => ({ modifierId: m.modifierId, name: m.name, price: m.price, quantity: m.quantity })) },
      },
    });
    ids.push(row.id);
  }
  return ids;
}

/**
 * Recomputes every amount on an order from its item snapshots and applied discounts. Called in
 * the same transaction as any change, so stored totals are always the engine's output.
 */
export async function recomputeOrder(tx: Tx, orderId: string) {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    include: {
      items: { where: { status: 'ACTIVE' }, include: { modifiers: true }, orderBy: { createdAt: 'asc' } },
      appliedDiscounts: { orderBy: { createdAt: 'asc' } },
    },
  });
  const settings = await branchBilling(tx, order.organizationId, order.branchId);
  const asInput = (d: { type: 'PERCENTAGE' | 'FIXED'; value: Prisma.Decimal }): DiscountInput => ({ type: d.type, value: d.value });
  const activeIds = new Set(order.items.map((i) => i.id));
  const itemDiscounts = order.appliedDiscounts.filter((d) => d.scope === 'ITEM' && d.orderItemId && activeIds.has(d.orderItemId));
  const orderDiscounts = order.appliedDiscounts.filter((d) => d.scope === 'ORDER');

  const result = computeBill({
    lines: order.items.map((i) => ({
      key: i.id,
      unitPrice: i.unitPrice,
      modifiersPerUnit: i.modifiers.reduce((a, m) => a.add(new Dec(m.price).mul(m.quantity)), new Dec(0)),
      quantity: i.quantity,
      taxRate: i.taxRate,
      priceIncludesTax: i.priceIncludesTax,
      discounts: itemDiscounts.filter((d) => d.orderItemId === i.id).map(asInput),
    })),
    orderDiscounts: orderDiscounts.map(asInput),
    // Restaurant service is supplied where it is performed (IGST Act s.12(3)), so it is always intra-state.
    supplyType: 'INTRA_STATE',
    // Service charge applies to dine-in only.
    serviceChargePercent: order.orderType === 'DINE_IN' ? settings.serviceChargePercent : 0,
    roundingMode: settings.roundingMode,
  });

  for (const l of result.lines) {
    await tx.orderItem.update({
      where: { id: l.key },
      data: {
        modifiersTotal: l.modifiersTotal,
        lineSubtotal: l.lineSubtotal,
        discountAmount: l.discountAmount,
        taxableAmount: l.taxableAmount,
        cgstAmount: l.cgstAmount,
        sgstAmount: l.sgstAmount,
        igstAmount: l.igstAmount,
        taxAmount: l.taxAmount,
        lineTotal: l.lineTotal,
      },
    });
    const ds = itemDiscounts.filter((d) => d.orderItemId === l.key);
    for (const [k, d] of ds.entries()) {
      await tx.appliedDiscount.update({ where: { id: d.id }, data: { amount: l.itemDiscountAmounts[k] } });
    }
  }
  // Discounts on cancelled items no longer apply.
  const orphaned = order.appliedDiscounts.filter((d) => d.scope === 'ITEM' && !itemDiscounts.includes(d));
  if (orphaned.length) await tx.appliedDiscount.updateMany({ where: { id: { in: orphaned.map((d) => d.id) } }, data: { amount: 0 } });
  for (const [k, d] of orderDiscounts.entries()) {
    await tx.appliedDiscount.update({ where: { id: d.id }, data: { amount: result.orderDiscountAmounts[k] } });
  }

  await tx.order.update({
    where: { id: orderId },
    data: {
      subtotal: result.subtotal,
      discountTotal: result.discountTotal,
      taxableAmount: result.taxableAmount,
      cgstAmount: result.cgstAmount,
      sgstAmount: result.sgstAmount,
      igstAmount: result.igstAmount,
      taxTotal: result.taxTotal,
      serviceCharge: result.serviceCharge,
      roundOff: result.roundOff,
      grandTotal: result.grandTotal,
    },
  });
  return { result, settings };
}
