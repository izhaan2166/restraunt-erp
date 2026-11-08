import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { requireInBranch } from '../../common/auth/branch-access';
import { Paginated } from '../../common/dto/pagination';
import { Errors } from '../../common/errors/app-error';
import type { RequestMeta } from '../../common/http/request-meta';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthPrincipal } from '../auth/principal';
import {
  AdjustmentDto,
  CreateIngredientDto,
  ListIngredientsQuery,
  MovementsQuery,
  RecipeQuery,
  SetLevelsDto,
  SetRecipeDto,
  StockCountDto,
  StockQuery,
  UpdateIngredientDto,
  WastageDto,
} from './dto/inventory.dto';
import { movementValue, postMovement } from './stock';
import { UnitLike, money2, pricePerBase, qty3, recipeUsage, toBase } from './units';

type Tx = Prisma.TransactionClient;
const Dec = Prisma.Decimal;
const ZERO = new Dec(0);

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ───────────── Units & ingredients ─────────────

  units() {
    return this.prisma.unit.findMany({ orderBy: [{ dimension: 'asc' }, { factorToBase: 'asc' }] });
  }

  async listIngredients(actor: AuthPrincipal, q: ListIngredientsQuery) {
    const where: Prisma.IngredientWhereInput = {
      organizationId: actor.organizationId,
      deletedAt: null,
      isActive: q.includeInactive ? undefined : true,
      ...(q.search ? { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { sku: { contains: q.search, mode: 'insensitive' } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.ingredient.findMany({ where, include: { baseUnit: true }, orderBy: { name: q.order }, skip: q.skip, take: q.pageSize }),
      this.prisma.ingredient.count({ where }),
    ]);
    return new Paginated(rows, total, q);
  }

  async getIngredient(actor: AuthPrincipal, id: string) {
    const ing = await this.prisma.ingredient.findFirst({ where: { id, organizationId: actor.organizationId, deletedAt: null }, include: { baseUnit: true } });
    if (!ing) throw Errors.notFound('Ingredient');
    return ing;
  }

  async createIngredient(actor: AuthPrincipal, dto: CreateIngredientDto, meta: RequestMeta) {
    const unit = await this.unitByCode(dto.baseUnit);
    if (!unit.factorToBase.eq(1)) {
      throw Errors.badRequest('INVALID_BASE_UNIT', `Keep stock in the smallest unit (g, ml or pc), not ${unit.code}; purchases and recipes can still use ${unit.code}`);
    }
    return this.prisma.$transaction(async (tx) => {
      await this.assertUniqueName(tx, actor.organizationId, dto.name.trim());
      const ing = await tx.ingredient.create({
        data: { organizationId: actor.organizationId, name: dto.name.trim(), sku: dto.sku?.trim() || null, category: dto.category?.trim() || null, baseUnitId: unit.id },
        include: { baseUnit: true },
      });
      await this.log(tx, actor, null, 'ingredient.created', 'ingredient', ing.id, undefined, { name: ing.name, baseUnit: unit.code }, meta);
      return ing;
    });
  }

  async updateIngredient(actor: AuthPrincipal, id: string, dto: UpdateIngredientDto, meta: RequestMeta) {
    const before = await this.getIngredient(actor, id);
    return this.prisma.$transaction(async (tx) => {
      if (dto.name && dto.name.trim().toLowerCase() !== before.name.toLowerCase()) await this.assertUniqueName(tx, actor.organizationId, dto.name.trim());
      const ing = await tx.ingredient.update({
        where: { id },
        data: {
          name: dto.name?.trim(),
          sku: dto.sku === undefined ? undefined : dto.sku.trim() || null,
          category: dto.category === undefined ? undefined : dto.category.trim() || null,
          isActive: dto.isActive,
        },
        include: { baseUnit: true },
      });
      await this.log(tx, actor, null, 'ingredient.updated', 'ingredient', id, { name: before.name, isActive: before.isActive }, dto, meta);
      return ing;
    });
  }

  /** Soft delete; refused while a recipe uses the ingredient or any branch still holds stock. */
  async deleteIngredient(actor: AuthPrincipal, id: string, meta: RequestMeta) {
    await this.getIngredient(actor, id);
    await this.prisma.$transaction(async (tx) => {
      const recipes = await tx.recipeItem.count({ where: { ingredientId: id, recipe: { isActive: true } } });
      if (recipes) throw Errors.conflict('INGREDIENT_IN_USE', `Used by ${recipes} active recipe(s); remove it from them first`);
      const held = await tx.inventoryBalance.count({ where: { ingredientId: id, quantity: { not: 0 } } });
      if (held) throw Errors.conflict('INGREDIENT_HAS_STOCK', 'Some branches still hold this ingredient; count it to zero first');
      await tx.ingredient.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
      await this.log(tx, actor, null, 'ingredient.deleted', 'ingredient', id, undefined, undefined, meta);
    });
  }

  // ───────────── Stock levels ─────────────

  /** Every active ingredient with its stock in the branch (0 when never stocked). */
  async stock(actor: AuthPrincipal, q: StockQuery) {
    const ingredients = await this.prisma.ingredient.findMany({
      where: {
        organizationId: actor.organizationId,
        deletedAt: null,
        isActive: true,
        ...(q.search ? { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { sku: { contains: q.search, mode: 'insensitive' } }] } : {}),
      },
      include: { baseUnit: true, balances: { where: { branchId: q.branchId } } },
      orderBy: { name: 'asc' },
    });
    const rows = ingredients.map((i) => {
      const b = i.balances[0];
      const quantity = b?.quantity ?? ZERO;
      const minimumLevel = b?.minimumLevel ?? ZERO;
      const averageCost = b?.averageCost ?? ZERO;
      return {
        ingredientId: i.id,
        name: i.name,
        sku: i.sku,
        category: i.category,
        unit: i.baseUnit.code,
        quantity,
        minimumLevel,
        averageCost,
        stockValue: money2(Dec.max(quantity, 0).mul(averageCost)),
        isLow: minimumLevel.gt(0) && quantity.lt(minimumLevel),
        isNegative: quantity.lt(0),
        updatedAt: b?.updatedAt ?? null,
      };
    });
    return q.lowOnly ? rows.filter((r) => r.isLow) : rows;
  }

  async setLevels(actor: AuthPrincipal, dto: SetLevelsDto, meta: RequestMeta) {
    const ids = [...new Set(dto.levels.map((l) => l.ingredientId))];
    if (ids.length !== dto.levels.length) throw Errors.badRequest('DUPLICATE_LINE', 'Each ingredient may appear once');
    await this.prisma.$transaction(async (tx) => {
      await this.ingredientsOrThrow(tx, actor.organizationId, ids);
      for (const l of dto.levels) {
        await tx.inventoryBalance.upsert({
          where: { branchId_ingredientId: { branchId: dto.branchId, ingredientId: l.ingredientId } },
          create: { organizationId: actor.organizationId, branchId: dto.branchId, ingredientId: l.ingredientId, minimumLevel: new Dec(l.minimumLevel) },
          update: { minimumLevel: new Dec(l.minimumLevel), version: { increment: 1 } },
        });
      }
      await this.log(tx, actor, dto.branchId, 'inventory.levels_set', 'branch', dto.branchId, undefined, { levels: dto.levels }, meta);
    });
    return this.stock(actor, { branchId: dto.branchId });
  }

  async movements(actor: AuthPrincipal, q: MovementsQuery) {
    const where: Prisma.StockMovementWhereInput = {
      organizationId: actor.organizationId,
      branchId: q.branchId,
      ingredientId: q.ingredientId,
      type: q.type?.length ? { in: q.type } : undefined,
      createdAt: q.from || q.to ? { gte: q.from ? new Date(q.from) : undefined, lte: q.to ? new Date(q.to) : undefined } : undefined,
    };
    const [rows, total] = await Promise.all([
      this.prisma.stockMovement.findMany({
        where,
        include: { ingredient: { select: { name: true, baseUnit: { select: { code: true } } } } },
        orderBy: [{ createdAt: q.order }, { id: q.order }],
        skip: q.skip,
        take: q.pageSize,
      }),
      this.prisma.stockMovement.count({ where }),
    ]);
    return new Paginated(
      rows.map(({ ingredient, ...m }) => ({ ...m, ingredientName: ingredient.name, unit: ingredient.baseUnit.code, value: movementValue(m.quantity, m.unitCost) })),
      total,
      q,
    );
  }

  // ───────────── Manual stock changes ─────────────

  async adjust(actor: AuthPrincipal, dto: AdjustmentDto, meta: RequestMeta) {
    return this.prisma.$transaction(async (tx) => {
      const { ingredient, base } = await this.lineQuantity(tx, actor.organizationId, dto.ingredientId, dto.quantity, dto.unit);
      const signed = dto.direction === 'IN' ? base : base.neg();
      const adj = await tx.stockAdjustment.create({
        data: { organizationId: actor.organizationId, branchId: dto.branchId, ingredientId: ingredient.id, quantity: signed, reason: dto.reason.trim(), createdById: actor.userId, approvedById: actor.userId },
      });
      const movement = await postMovement(tx, {
        organizationId: actor.organizationId,
        branchId: dto.branchId,
        ingredientId: ingredient.id,
        type: dto.direction === 'IN' ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT',
        quantity: signed,
        referenceType: 'stock_adjustment',
        referenceId: adj.id,
        dedupeKey: `stock_adjustment:${adj.id}`,
        note: dto.reason.trim(),
        userId: actor.userId,
        noNegative: true,
      });
      await this.log(tx, actor, dto.branchId, 'inventory.adjusted', 'stock_adjustment', adj.id, undefined, { ingredient: ingredient.name, quantity: signed, reason: adj.reason }, meta);
      return { adjustment: adj, movement };
    });
  }

  async wastage(actor: AuthPrincipal, dto: WastageDto, meta: RequestMeta) {
    return this.prisma.$transaction(async (tx) => {
      const { ingredient, base } = await this.lineQuantity(tx, actor.organizationId, dto.ingredientId, dto.quantity, dto.unit);
      const id = randomUUID();
      const movement = await postMovement(tx, {
        organizationId: actor.organizationId,
        branchId: dto.branchId,
        ingredientId: ingredient.id,
        type: 'WASTAGE',
        quantity: base.neg(),
        referenceType: 'wastage',
        referenceId: id,
        dedupeKey: `wastage:${id}`,
        note: dto.reason.trim(),
        userId: actor.userId,
        noNegative: true,
      });
      const cost = movement ? movementValue(movement.quantity, movement.unitCost) : ZERO;
      const record = await tx.wastageRecord.create({
        data: { id, organizationId: actor.organizationId, branchId: dto.branchId, ingredientId: ingredient.id, quantity: qty3(base), cost, reason: dto.reason.trim(), recordedById: actor.userId },
      });
      await this.log(tx, actor, dto.branchId, 'inventory.wastage', 'wastage', id, undefined, { ingredient: ingredient.name, quantity: record.quantity, cost, reason: record.reason }, meta);
      return { wastage: record, movement };
    });
  }

  /**
   * Physical count: sets each ingredient to the counted quantity by posting the difference. The
   * first count of an ingredient in a branch is its opening stock (optionally valued with unitCost).
   */
  async count(actor: AuthPrincipal, dto: StockCountDto, meta: RequestMeta) {
    const ids = dto.counts.map((c) => c.ingredientId);
    if (new Set(ids).size !== ids.length) throw Errors.badRequest('DUPLICATE_LINE', 'Each ingredient may appear once');
    const results = await this.prisma.$transaction(async (tx) => {
      const out: { ingredientId: string; name: string; before: Prisma.Decimal; counted: Prisma.Decimal; difference: Prisma.Decimal; type: string | null }[] = [];
      for (const c of [...dto.counts].sort((a, b) => a.ingredientId.localeCompare(b.ingredientId))) {
        const { ingredient, base, unit } = await this.lineQuantity(tx, actor.organizationId, c.ingredientId, c.quantity, c.unit);
        await tx.inventoryBalance.upsert({
          where: { branchId_ingredientId: { branchId: dto.branchId, ingredientId: ingredient.id } },
          create: { organizationId: actor.organizationId, branchId: dto.branchId, ingredientId: ingredient.id },
          update: {},
        });
        const [bal] = await tx.$queryRaw<{ quantity: Prisma.Decimal }[]>`
          SELECT quantity FROM inventory_balances WHERE branch_id = ${dto.branchId}::uuid AND ingredient_id = ${ingredient.id}::uuid FOR UPDATE`;
        const before = new Dec(bal.quantity);
        const counted = qty3(base);
        const diff = counted.sub(before);
        const first = (await tx.stockMovement.count({ where: { branchId: dto.branchId, ingredientId: ingredient.id } })) === 0;
        let type: 'OPENING' | 'ADJUSTMENT_IN' | 'ADJUSTMENT_OUT' | null = null;
        if (!diff.isZero()) {
          type = first && diff.gt(0) ? 'OPENING' : diff.gt(0) ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT';
          const adj = await tx.stockAdjustment.create({
            data: { organizationId: actor.organizationId, branchId: dto.branchId, ingredientId: ingredient.id, quantity: diff, reason: dto.reason.trim(), createdById: actor.userId, approvedById: actor.userId },
          });
          await postMovement(tx, {
            organizationId: actor.organizationId,
            branchId: dto.branchId,
            ingredientId: ingredient.id,
            type,
            quantity: diff,
            unitCost: c.unitCost ? pricePerBase(new Dec(c.unitCost), unit, ingredient.baseUnit) : undefined,
            referenceType: 'stock_adjustment',
            referenceId: adj.id,
            dedupeKey: `stock_adjustment:${adj.id}`,
            note: `Count: ${dto.reason.trim()}`,
            userId: actor.userId,
          });
        }
        out.push({ ingredientId: ingredient.id, name: ingredient.name, before, counted, difference: diff, type });
      }
      await this.log(tx, actor, dto.branchId, 'inventory.counted', 'branch', dto.branchId, undefined, { reason: dto.reason, counts: out }, meta);
      return out;
    });
    return results;
  }

  // ───────────── Recipes ─────────────

  async getRecipe(actor: AuthPrincipal, productId: string, q: RecipeQuery) {
    const product = await this.productOrThrow(actor.organizationId, productId, q.variantId);
    const recipe = await this.prisma.recipe.findFirst({
      where: { organizationId: actor.organizationId, productId, variantId: q.variantId ?? null, isActive: true },
      include: { items: { include: { unit: true, ingredient: { include: { baseUnit: true } } }, orderBy: { ingredient: { name: 'asc' } } } },
    });
    if (!recipe) throw Errors.notFound('Recipe');
    let costs: Map<string, Prisma.Decimal> | null = null;
    if (q.branchId) {
      requireInBranch(actor, q.branchId, ['inventory.read'], 'Branch');
      const bals = await this.prisma.inventoryBalance.findMany({ where: { branchId: q.branchId, ingredientId: { in: recipe.items.map((i) => i.ingredientId) } } });
      costs = new Map(bals.map((b) => [b.ingredientId, b.averageCost]));
    }
    const items = recipe.items.map((it) => {
      const perPortion = qty3(recipeUsage(toBase(it.quantity, it.unit, it.ingredient.baseUnit), it.wastagePercent, recipe.yieldQuantity, new Dec(1)));
      return {
        ingredientId: it.ingredientId,
        ingredientName: it.ingredient.name,
        quantity: it.quantity,
        unit: it.unit.code,
        wastagePercent: it.wastagePercent,
        perPortion,
        baseUnit: it.ingredient.baseUnit.code,
        estimatedCost: costs ? money2(perPortion.mul(costs.get(it.ingredientId) ?? ZERO)) : undefined,
      };
    });
    return {
      id: recipe.id,
      productId,
      productName: product.name,
      variantId: recipe.variantId,
      yieldQuantity: recipe.yieldQuantity,
      items,
      estimatedCostPerPortion: costs ? money2(items.reduce((s, i) => s.add(i.estimatedCost ?? ZERO), ZERO)) : undefined,
      updatedAt: recipe.updatedAt,
    };
  }

  /** Replaces the active recipe; the previous one is kept (inactive) for history. */
  async setRecipe(actor: AuthPrincipal, productId: string, dto: SetRecipeDto, meta: RequestMeta) {
    await this.productOrThrow(actor.organizationId, productId, dto.variantId);
    const ids = dto.items.map((i) => i.ingredientId);
    if (new Set(ids).size !== ids.length) throw Errors.badRequest('DUPLICATE_LINE', 'Each ingredient may appear once');
    const yieldQuantity = new Dec(dto.yieldQuantity ?? '1');
    if (yieldQuantity.lte(0)) throw Errors.badRequest('INVALID_YIELD', 'yieldQuantity must be greater than 0');
    await this.prisma.$transaction(async (tx) => {
      const ingredients = await this.ingredientsOrThrow(tx, actor.organizationId, ids);
      const units = await tx.unit.findMany();
      const lines = dto.items.map((l) => {
        const ing = ingredients.find((i) => i.id === l.ingredientId)!;
        const unit = units.find((u) => u.code === l.unit);
        if (!unit) throw Errors.badRequest('INVALID_UNIT', `Unknown unit "${l.unit}"`);
        toBase(new Dec(1), unit, ing.baseUnit); // same dimension check
        const quantity = new Dec(l.quantity);
        if (quantity.lte(0)) throw Errors.badRequest('INVALID_QUANTITY', `${ing.name}: quantity must be greater than 0`);
        return { ingredientId: ing.id, unitId: unit.id, quantity, wastagePercent: new Dec(l.wastagePercent ?? '0') };
      });
      const previous = await tx.recipe.findFirst({ where: { organizationId: actor.organizationId, productId, variantId: dto.variantId ?? null, isActive: true }, include: { items: true } });
      if (previous) await tx.recipe.update({ where: { id: previous.id }, data: { isActive: false } });
      const recipe = await tx.recipe.create({
        data: { organizationId: actor.organizationId, productId, variantId: dto.variantId ?? null, yieldQuantity, items: { create: lines } },
      });
      await this.log(
        tx,
        actor,
        null,
        'recipe.set',
        'recipe',
        recipe.id,
        previous ? { recipeId: previous.id, yieldQuantity: previous.yieldQuantity, items: previous.items.map((i) => ({ ingredientId: i.ingredientId, quantity: i.quantity, unitId: i.unitId })) } : undefined,
        { productId, variantId: dto.variantId ?? null, yieldQuantity, items: dto.items },
        meta,
      );
    });
    return this.getRecipe(actor, productId, { variantId: dto.variantId });
  }

  async deleteRecipe(actor: AuthPrincipal, productId: string, q: RecipeQuery, meta: RequestMeta) {
    await this.productOrThrow(actor.organizationId, productId, q.variantId);
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.recipe.findFirst({ where: { organizationId: actor.organizationId, productId, variantId: q.variantId ?? null, isActive: true } });
      if (!r) throw Errors.notFound('Recipe');
      await tx.recipe.update({ where: { id: r.id }, data: { isActive: false } });
      await this.log(tx, actor, null, 'recipe.removed', 'recipe', r.id, undefined, { productId, variantId: q.variantId ?? null }, meta);
    });
  }

  // ───────────── Internals ─────────────

  private async unitByCode(code: string) {
    const unit = await this.prisma.unit.findUnique({ where: { code } });
    if (!unit) throw Errors.badRequest('INVALID_UNIT', `Unknown unit "${code}"`);
    return unit;
  }

  private async assertUniqueName(tx: Tx, organizationId: string, name: string) {
    const clash = await tx.ingredient.findFirst({ where: { organizationId, name: { equals: name, mode: 'insensitive' } } });
    if (clash) throw Errors.conflict('DUPLICATE_NAME', `An ingredient named "${clash.name}" already exists${clash.deletedAt ? ' (deleted)' : ''}`);
  }

  private async ingredientsOrThrow(tx: Tx, organizationId: string, ids: string[]) {
    const rows = await tx.ingredient.findMany({ where: { id: { in: ids }, organizationId, deletedAt: null }, include: { baseUnit: true } });
    const missing = ids.filter((id) => !rows.some((r) => r.id === id));
    if (missing.length) throw Errors.badRequest('INVALID_INGREDIENT', 'Unknown ingredient(s)', { missing });
    return rows;
  }

  /** Validates the ingredient and converts the quantity (in `unit`, default the base unit) to base units. */
  private async lineQuantity(tx: Tx, organizationId: string, ingredientId: string, quantity: string, unitCode?: string) {
    const [ingredient] = await this.ingredientsOrThrow(tx, organizationId, [ingredientId]);
    if (!ingredient.isActive) throw Errors.unprocessable('INGREDIENT_INACTIVE', `${ingredient.name} is inactive`);
    let unit: UnitLike = ingredient.baseUnit;
    if (unitCode && unitCode !== ingredient.baseUnit.code) {
      const u = await tx.unit.findUnique({ where: { code: unitCode } });
      if (!u) throw Errors.badRequest('INVALID_UNIT', `Unknown unit "${unitCode}"`);
      unit = u;
    }
    const base = qty3(toBase(new Dec(quantity), unit, ingredient.baseUnit));
    if (base.lte(0)) throw Errors.badRequest('INVALID_QUANTITY', 'quantity must be greater than 0');
    return { ingredient, base, unit };
  }

  private async productOrThrow(organizationId: string, productId: string, variantId?: string) {
    const p = await this.prisma.product.findFirst({ where: { id: productId, organizationId, deletedAt: null }, include: { variants: { select: { id: true } } } });
    if (!p) throw Errors.notFound('Product');
    if (variantId && !p.variants.some((v) => v.id === variantId)) throw Errors.badRequest('INVALID_VARIANT', 'The variant does not belong to this product');
    return p;
  }

  private log(tx: Tx, actor: AuthPrincipal, branchId: string | null, action: string, entityType: string, entityId: string, before: unknown, after: unknown, meta: RequestMeta) {
    return this.audit.record({ organizationId: actor.organizationId, branchId, actorUserId: actor.userId, action, entityType, entityId, before, after, meta }, tx);
  }
}

