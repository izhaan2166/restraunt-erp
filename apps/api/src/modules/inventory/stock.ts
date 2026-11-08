import { Prisma, StockMovementType } from '@prisma/client';
import { Errors } from '../../common/errors/app-error';
import { averageCost, cost4, money2, qty3, recipeUsage, toBase } from './units';

type Tx = Prisma.TransactionClient;
type D = Prisma.Decimal;
const Dec = Prisma.Decimal;
const ZERO = new Dec(0);

const INBOUND: StockMovementType[] = ['OPENING', 'PURCHASE_RECEIPT', 'SALE_REVERSAL', 'ADJUSTMENT_IN', 'TRANSFER_IN'];

export interface MovementInput {
  organizationId: string;
  branchId: string;
  ingredientId: string;
  type: StockMovementType;
  /** Signed, in the ingredient's base unit: positive in, negative out. */
  quantity: D;
  /** Purchase cost per base unit (receipts only); other movements are valued at the average cost. */
  unitCost?: D;
  referenceType: string;
  referenceId: string;
  /** One business event moves stock at most once: a repeat with the same key is ignored. */
  dedupeKey: string;
  note?: string | null;
  userId: string;
  /** Refuse to take the balance below zero (manual outflows, or sales when the branch forbids negative stock). */
  noNegative?: boolean;
}

/**
 * Posts one ledger entry and updates the branch balance under a row lock, so concurrent
 * movements of one ingredient are applied one after another and `balanceAfter` is exact.
 * Returns null when the dedupe key was already used.
 */
export async function postMovement(tx: Tx, m: MovementInput) {
  const quantity = qty3(m.quantity);
  if (quantity.isZero()) return null;
  if (INBOUND.includes(m.type) !== quantity.gt(0)) throw new Error(`Movement ${m.type} has the wrong sign`);
  const seen = await tx.stockMovement.findUnique({ where: { dedupeKey: m.dedupeKey }, select: { id: true } });
  if (seen) return null;

  await tx.inventoryBalance.upsert({
    where: { branchId_ingredientId: { branchId: m.branchId, ingredientId: m.ingredientId } },
    create: { organizationId: m.organizationId, branchId: m.branchId, ingredientId: m.ingredientId },
    update: {},
  });
  const [bal] = await tx.$queryRaw<{ id: string; quantity: D; average_cost: D }[]>`
    SELECT id, quantity, average_cost FROM inventory_balances
    WHERE branch_id = ${m.branchId}::uuid AND ingredient_id = ${m.ingredientId}::uuid FOR UPDATE`;
  const onHand = new Dec(bal.quantity);
  const avg = new Dec(bal.average_cost);
  const after = onHand.add(quantity);
  if (m.noNegative && quantity.lt(0) && after.lt(0)) {
    throw Errors.conflict('INSUFFICIENT_STOCK', `Only ${onHand.toString()} in stock`, { ingredientId: m.ingredientId, onHand: onHand.toString(), required: quantity.neg().toString() });
  }
  const isReceipt = m.type === 'PURCHASE_RECEIPT' || (m.type === 'OPENING' && m.unitCost);
  const newAvg = isReceipt && m.unitCost ? averageCost(onHand, avg, quantity, m.unitCost) : avg;
  await tx.inventoryBalance.update({ where: { id: bal.id }, data: { quantity: after, averageCost: newAvg, version: { increment: 1 } } });
  return tx.stockMovement.create({
    data: {
      organizationId: m.organizationId,
      branchId: m.branchId,
      ingredientId: m.ingredientId,
      type: m.type,
      quantity,
      unitCost: isReceipt && m.unitCost ? cost4(m.unitCost) : avg,
      balanceAfter: after,
      referenceType: m.referenceType,
      referenceId: m.referenceId,
      dedupeKey: m.dedupeKey,
      note: m.note ?? null,
      createdById: m.userId,
    },
  });
}

/** Value of a movement at its unit cost, for wastage and reports. */
export const movementValue = (quantity: D, unitCost: D | null) => money2(quantity.abs().mul(unitCost ?? ZERO));

// ───────────── Recipes → ingredient usage ─────────────

interface SoldLine {
  productId: string;
  variantId: string | null;
  quantity: D;
}

/**
 * Ingredient usage (base units) for one sold line: the variant's recipe, else the product's;
 * a combo without its own recipe uses the recipes of its contents. Products without a recipe use
 * no stock.
 */
export async function usageFor(tx: Tx, organizationId: string, line: SoldLine): Promise<Map<string, D>> {
  const out = new Map<string, D>();
  const add = (k: string, v: D) => out.set(k, (out.get(k) ?? ZERO).add(v));
  const recipe = await activeRecipe(tx, organizationId, line.productId, line.variantId);
  if (recipe) {
    for (const it of recipe.items) {
      const perBatch = toBase(it.quantity, it.unit, it.ingredient.baseUnit);
      add(it.ingredientId, recipeUsage(perBatch, it.wastagePercent, recipe.yieldQuantity, line.quantity));
    }
    return out;
  }
  const combo = await tx.comboItem.findMany({ where: { comboProductId: line.productId } });
  for (const c of combo) {
    const part = await usageFor(tx, organizationId, { productId: c.productId, variantId: c.variantId, quantity: line.quantity.mul(c.quantity) });
    for (const [k, v] of part) add(k, v);
  }
  return out;
}

async function activeRecipe(tx: Tx, organizationId: string, productId: string, variantId: string | null) {
  const include = { items: { include: { unit: true, ingredient: { include: { baseUnit: true } } } } } as const;
  if (variantId) {
    const own = await tx.recipe.findFirst({ where: { organizationId, productId, variantId, isActive: true }, include });
    if (own) return own;
  }
  return tx.recipe.findFirst({ where: { organizationId, productId, variantId: null, isActive: true }, include });
}

// ───────────── Sales consumption ─────────────

/**
 * Brings an order's stock consumption in line with the branch policy. Safe to call after any
 * change to the order: it posts only the difference, and every entry has a unique dedupe key.
 *
 *  ON_ORDER_COMPLETE (default): active items are consumed when the order is completed; reopening
 *    the order puts the stock back.
 *  ON_ORDER_CONFIRM: items are consumed when sent to the kitchen. An item taken back before the
 *    kitchen started it is put back; once started, the ingredients stay used.
 *  NONE: sales do not move stock.
 *
 * An item that was consumed keeps that consumption (from the recipe at the time) until it is put
 * back in full, so later recipe edits never rewrite history.
 */
export async function syncOrderConsumption(tx: Tx, userId: string, orderId: string) {
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { id: true, organizationId: true, branchId: true, status: true, orderNumber: true } });
  const settings = await tx.branchSettings.findUnique({ where: { branchId: order.branchId }, select: { stockDeductionPolicy: true, allowNegativeStock: true } });
  const policy = settings?.stockDeductionPolicy ?? 'ON_ORDER_COMPLETE';
  if (policy === 'NONE') return;
  const items = await tx.orderItem.findMany({
    where: { orderId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, productId: true, variantId: true, quantity: true, status: true, ticketItems: { select: { status: true, startedAt: true } } },
  });
  const posted = await tx.stockMovement.findMany({
    where: { referenceType: 'order_item', referenceId: { in: items.map((i) => i.id) } },
    select: { referenceId: true, ingredientId: true, quantity: true },
  });

  for (const item of items) {
    const sent = item.ticketItems.some((t) => t.status !== 'CANCELLED');
    const started = item.ticketItems.some((t) => t.startedAt);
    const should =
      policy === 'ON_ORDER_COMPLETE'
        ? order.status === 'COMPLETED' && item.status === 'ACTIVE'
        : (item.status === 'ACTIVE' && (sent || order.status === 'COMPLETED')) || (item.status === 'CANCELLED' && started);

    const mine = posted.filter((p) => p.referenceId === item.id);
    const net = new Map<string, D>();
    const count = new Map<string, number>();
    for (const p of mine) {
      net.set(p.ingredientId, (net.get(p.ingredientId) ?? ZERO).add(p.quantity));
      count.set(p.ingredientId, (count.get(p.ingredientId) ?? 0) + 1);
    }
    const consumed = [...net.values()].some((v) => !v.isZero());
    const base = { organizationId: order.organizationId, branchId: order.branchId, referenceType: 'order_item', referenceId: item.id, userId };

    if (should && !consumed) {
      const usage = await usageFor(tx, order.organizationId, item);
      for (const [ingredientId, q] of [...usage].sort(([a], [b]) => a.localeCompare(b))) {
        await postMovement(tx, {
          ...base,
          ingredientId,
          type: 'SALE_CONSUMPTION',
          quantity: q.neg(),
          dedupeKey: `order_item:${item.id}:${ingredientId}:${(count.get(ingredientId) ?? 0) + 1}`,
          note: `Order ${order.orderNumber}`,
          noNegative: settings?.allowNegativeStock === false,
        });
      }
    } else if (!should && consumed) {
      for (const [ingredientId, q] of [...net].sort(([a], [b]) => a.localeCompare(b))) {
        if (!q.lt(0)) continue;
        await postMovement(tx, {
          ...base,
          ingredientId,
          type: 'SALE_REVERSAL',
          quantity: q.neg(),
          dedupeKey: `order_item:${item.id}:${ingredientId}:${(count.get(ingredientId) ?? 0) + 1}`,
          note: `Order ${order.orderNumber} – put back`,
        });
      }
    }
  }
}

/**
 * A completed refund marked `restock` against a credit note puts back the stock used by the
 * credited quantities (food returned unused). Without `restock` the food counts as used.
 */
export async function restockForRefund(tx: Tx, userId: string, refund: { id: string; restock: boolean; creditNoteId: string | null; status: string }) {
  if (!refund.restock || !refund.creditNoteId || refund.status !== 'COMPLETED') return;
  const cn = await tx.creditNote.findUniqueOrThrow({
    where: { id: refund.creditNoteId },
    include: { items: { include: { invoiceItem: { select: { orderItemId: true } } } } },
  });
  for (const line of cn.items) {
    const orderItemId = line.invoiceItem.orderItemId;
    if (!orderItemId) continue; // service charge lines
    const item = await tx.orderItem.findUniqueOrThrow({ where: { id: orderItemId }, include: { order: { select: { organizationId: true, branchId: true, orderNumber: true } } } });
    const rows = await tx.stockMovement.groupBy({ by: ['ingredientId'], where: { referenceType: 'order_item', referenceId: orderItemId }, _sum: { quantity: true } });
    for (const r of rows.sort((a, b) => a.ingredientId.localeCompare(b.ingredientId))) {
      const used = (r._sum.quantity ?? ZERO).neg();
      if (!used.gt(0)) continue;
      await postMovement(tx, {
        organizationId: item.order.organizationId,
        branchId: item.order.branchId,
        ingredientId: r.ingredientId,
        type: 'SALE_REVERSAL',
        quantity: used.mul(line.quantity).div(item.quantity),
        referenceType: 'credit_note',
        referenceId: cn.id,
        dedupeKey: `credit_note:${cn.id}:${line.id}:${r.ingredientId}`,
        note: `Restocked with refund (credit note ${cn.creditNoteNumber})`,
        userId,
      });
    }
  }
}

/**
 * For branches that forbid negative stock: refuses to send items to the kitchen when the
 * ingredients on hand cannot cover them.
 */
export async function assertStockFor(tx: Tx, organizationId: string, branchId: string, lines: SoldLine[]) {
  const need = new Map<string, D>();
  for (const l of lines) for (const [k, v] of await usageFor(tx, organizationId, l)) need.set(k, (need.get(k) ?? ZERO).add(v));
  if (!need.size) return;
  const balances = await tx.inventoryBalance.findMany({ where: { branchId, ingredientId: { in: [...need.keys()] } }, include: { ingredient: { select: { name: true } } } });
  const short = [...need]
    .map(([ingredientId, required]) => {
      const b = balances.find((x) => x.ingredientId === ingredientId);
      return { ingredientId, name: b?.ingredient.name, onHand: b?.quantity ?? ZERO, required: qty3(required) };
    })
    .filter((s) => s.onHand.lt(s.required));
  if (short.length) {
    throw Errors.conflict('INSUFFICIENT_STOCK', `Not enough stock: ${short.map((s) => s.name ?? s.ingredientId).join(', ')}`, {
      short: short.map((s) => ({ ...s, onHand: s.onHand.toString(), required: s.required.toString() })),
    });
  }
}
