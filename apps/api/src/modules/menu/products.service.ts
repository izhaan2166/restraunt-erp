import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Paginated } from '../../common/dto/pagination';
import { Errors } from '../../common/errors/app-error';
import type { RequestMeta } from '../../common/http/request-meta';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthPrincipal } from '../auth/principal';
import { sniffImage } from '../storage/image-validation';
import { StorageService } from '../storage/storage.service';
import {
  ComboItemInputDto,
  CreateProductDto,
  ListProductsQuery,
  SetAvailabilityDto,
  SetBranchPricesDto,
  UpdateProductDto,
  UpdateVariantDto,
  VariantInputDto,
} from './dto/menu.dto';
import { requirePriceRight } from './price-rights';

type Tx = Prisma.TransactionClient;

/** The part of a multer upload the service uses (memory storage). */
export interface UploadedImage {
  buffer: Buffer;
  size: number;
}

const DETAIL_INCLUDE = {
  category: { select: { id: true, name: true } },
  taxRate: { select: { id: true, name: true, rate: true, cgstRate: true, sgstRate: true, igstRate: true, cessRate: true } },
  variants: { orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] },
  modifierGroups: {
    orderBy: { sortOrder: 'asc' },
    include: { group: { include: { modifiers: { where: { isActive: true }, orderBy: { name: 'asc' } } } } },
  },
  comboItems: {
    include: {
      product: { select: { id: true, name: true, sku: true } },
      variant: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.ProductInclude;

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  // ───────────── Read ─────────────

  async list(actor: AuthPrincipal, q: ListProductsQuery) {
    const where: Prisma.ProductWhereInput = {
      organizationId: actor.organizationId,
      deletedAt: null,
      categoryId: q.categoryId,
      isActive: q.isActive,
      ...(q.search
        ? {
            OR: [
              { name: { contains: q.search, mode: 'insensitive' } },
              { sku: { contains: q.search.toUpperCase() } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { name: q.order }],
        skip: q.skip,
        take: q.pageSize,
        include: {
          category: { select: { id: true, name: true } },
          variants: { where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] },
        },
      }),
      this.prisma.product.count({ where }),
    ]);
    return new Paginated(rows, total, q);
  }

  async get(actor: AuthPrincipal, id: string, db: Tx | PrismaService = this.prisma) {
    const p = await db.product.findFirst({
      where: { id, organizationId: actor.organizationId, deletedAt: null },
      include: DETAIL_INCLUDE,
    });
    if (!p) throw Errors.notFound('Product');
    return p;
  }

  async branchPrices(actor: AuthPrincipal, id: string, branchId: string) {
    await this.get(actor, id);
    return this.prisma.branchProductPrice.findMany({ where: { productId: id, branchId }, orderBy: { variantId: 'asc' } });
  }

  // ───────────── Create / update / delete ─────────────

  async create(actor: AuthPrincipal, dto: CreateProductDto, meta: RequestMeta) {
    await this.assertCategory(actor, dto.categoryId);
    if (dto.taxRateId) await this.assertTaxRate(actor, dto.taxRateId);
    const variants = normaliseVariants(dto.variants ?? []);
    if (dto.modifierGroupIds?.length) await this.assertModifierGroups(actor, dto.modifierGroupIds);
    if (dto.comboItems?.length && !dto.isCombo) {
      throw Errors.badRequest('NOT_A_COMBO', 'comboItems can only be set when isCombo is true');
    }

    const id = await this.prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          organizationId: actor.organizationId,
          categoryId: dto.categoryId,
          taxRateId: dto.taxRateId,
          sku: dto.sku,
          name: dto.name.trim(),
          description: dto.description?.trim() || null,
          basePrice: dto.basePrice,
          hsnSac: dto.hsnSac,
          isVeg: dto.isVeg ?? true,
          stationCode: dto.stationCode,
          isCombo: dto.isCombo ?? false,
          sortOrder: dto.sortOrder ?? 0,
          variants: { create: variants },
          modifierGroups: { create: (dto.modifierGroupIds ?? []).map((groupId, i) => ({ groupId, sortOrder: i })) },
        },
      });
      if (dto.comboItems?.length) await this.writeComboItems(tx, actor, product.id, dto.comboItems);
      const after = await this.get(actor, product.id, tx);
      await this.audit.record(
        { organizationId: actor.organizationId, actorUserId: actor.userId, action: 'product.created', entityType: 'product', entityId: product.id, after, meta },
        tx,
      );
      return product.id;
    });
    return this.get(actor, id);
  }

  async update(actor: AuthPrincipal, id: string, dto: UpdateProductDto, meta: RequestMeta) {
    const before = await this.get(actor, id);
    if (dto.categoryId && dto.categoryId !== before.categoryId) await this.assertCategory(actor, dto.categoryId);
    if (dto.taxRateId && dto.taxRateId !== before.taxRateId) await this.assertTaxRate(actor, dto.taxRateId);
    const priceChanged = dto.basePrice !== undefined && !before.basePrice.equals(dto.basePrice);
    if (priceChanged) requirePriceRight(actor);

    await this.prisma.$transaction(async (tx) => {
      if (dto.modifierGroupIds) {
        await this.assertModifierGroups(actor, dto.modifierGroupIds);
        await tx.productModifierGroup.deleteMany({ where: { productId: id } });
        await tx.productModifierGroup.createMany({ data: dto.modifierGroupIds.map((groupId, i) => ({ productId: id, groupId, sortOrder: i })) });
      }
      await tx.product.update({
        where: { id },
        data: {
          categoryId: dto.categoryId,
          taxRateId: dto.taxRateId,
          sku: dto.sku,
          name: dto.name?.trim(),
          description: dto.description === undefined ? undefined : dto.description.trim() || null,
          basePrice: dto.basePrice,
          hsnSac: dto.hsnSac,
          isVeg: dto.isVeg,
          stationCode: dto.stationCode,
          sortOrder: dto.sortOrder,
          isActive: dto.isActive,
        },
      });
      const after = await this.get(actor, id, tx);
      await this.audit.record(
        {
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: priceChanged ? 'product.price_changed' : 'product.updated',
          entityType: 'product',
          entityId: id,
          before,
          after,
          meta,
        },
        tx,
      );
    });
    return this.get(actor, id);
  }

  async remove(actor: AuthPrincipal, id: string, meta: RequestMeta): Promise<void> {
    const before = await this.get(actor, id);
    const usedIn = await this.prisma.comboItem.findMany({
      where: { productId: id, combo: { deletedAt: null } },
      select: { combo: { select: { id: true, name: true } } },
    });
    if (usedIn.length) {
      throw Errors.conflict('PRODUCT_IN_COMBO', 'Remove this product from its combos first', {
        combos: usedIn.map((u) => u.combo),
      });
    }
    // Soft delete: past orders and invoices keep pointing at the product row.
    await this.prisma.$transaction(async (tx) => {
      await tx.product.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
      await this.audit.record(
        { organizationId: actor.organizationId, actorUserId: actor.userId, action: 'product.deleted', entityType: 'product', entityId: id, before, meta },
        tx,
      );
    });
  }

  // ───────────── Variants ─────────────

  async addVariant(actor: AuthPrincipal, productId: string, dto: VariantInputDto, meta: RequestMeta) {
    const product = await this.get(actor, productId);
    // A new variant sets a price that did not exist before, so it is a price change.
    requirePriceRight(actor);
    await this.prisma.$transaction(async (tx) => {
      const isFirst = product.variants.filter((v) => v.isActive).length === 0;
      const makeDefault = dto.isDefault === true || isFirst;
      if (makeDefault) await tx.productVariant.updateMany({ where: { productId, isDefault: true }, data: { isDefault: false } });
      const v = await tx.productVariant.create({
        data: { productId, name: dto.name.trim(), price: dto.price, isDefault: makeDefault, sortOrder: dto.sortOrder ?? 0 },
      });
      await this.audit.record(
        { organizationId: actor.organizationId, actorUserId: actor.userId, action: 'product_variant.created', entityType: 'product_variant', entityId: v.id, after: v, meta },
        tx,
      );
    });
    return this.get(actor, productId);
  }

  async updateVariant(actor: AuthPrincipal, productId: string, variantId: string, dto: UpdateVariantDto, meta: RequestMeta) {
    const product = await this.get(actor, productId);
    const before = product.variants.find((v) => v.id === variantId);
    if (!before) throw Errors.notFound('Variant');
    const priceChanged = dto.price !== undefined && !before.price.equals(dto.price);
    if (priceChanged) requirePriceRight(actor);
    if (dto.isActive === false && dto.isDefault === true) {
      throw Errors.badRequest('INVALID_DEFAULT', 'An inactive variant cannot be the default');
    }

    await this.prisma.$transaction(async (tx) => {
      if (dto.isDefault === true) {
        await tx.productVariant.updateMany({ where: { productId, isDefault: true, NOT: { id: variantId } }, data: { isDefault: false } });
      }
      const after = await tx.productVariant.update({
        where: { id: variantId },
        data: {
          name: dto.name?.trim(),
          price: dto.price,
          sortOrder: dto.sortOrder,
          isActive: dto.isActive,
          // Deactivating the default variant clears the flag; the next active one is promoted below.
          isDefault: dto.isActive === false ? false : dto.isDefault,
        },
      });
      if (before.isDefault && !after.isDefault) {
        const next = await tx.productVariant.findFirst({
          where: { productId, isActive: true, NOT: { id: variantId } },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        });
        if (next) await tx.productVariant.update({ where: { id: next.id }, data: { isDefault: true } });
      }
      await this.audit.record(
        {
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: priceChanged ? 'product_variant.price_changed' : 'product_variant.updated',
          entityType: 'product_variant',
          entityId: variantId,
          before,
          after,
          meta,
        },
        tx,
      );
    });
    return this.get(actor, productId);
  }

  // ───────────── Add-on groups & combos ─────────────

  async setModifierGroups(actor: AuthPrincipal, productId: string, groupIds: string[], meta: RequestMeta) {
    const before = await this.get(actor, productId);
    await this.assertModifierGroups(actor, groupIds);
    await this.prisma.$transaction(async (tx) => {
      await tx.productModifierGroup.deleteMany({ where: { productId } });
      await tx.productModifierGroup.createMany({ data: groupIds.map((groupId, i) => ({ productId, groupId, sortOrder: i })) });
      await this.audit.record(
        {
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: 'product.modifier_groups_set',
          entityType: 'product',
          entityId: productId,
          before: { groupIds: before.modifierGroups.map((g) => g.groupId) },
          after: { groupIds },
          meta,
        },
        tx,
      );
    });
    return this.get(actor, productId);
  }

  async setComboItems(actor: AuthPrincipal, productId: string, items: ComboItemInputDto[], meta: RequestMeta) {
    const before = await this.get(actor, productId);
    if (!before.isCombo) throw Errors.badRequest('NOT_A_COMBO', 'This product is not a combo');
    await this.prisma.$transaction(async (tx) => {
      await tx.comboItem.deleteMany({ where: { comboProductId: productId } });
      await this.writeComboItems(tx, actor, productId, items);
      await this.audit.record(
        {
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: 'product.combo_items_set',
          entityType: 'product',
          entityId: productId,
          before: { items: before.comboItems.map((c) => ({ productId: c.productId, variantId: c.variantId, quantity: c.quantity })) },
          after: { items },
          meta,
        },
        tx,
      );
    });
    return this.get(actor, productId);
  }

  private async writeComboItems(tx: Tx, actor: AuthPrincipal, comboId: string, items: ComboItemInputDto[]) {
    const seen = new Set<string>();
    for (const item of items) {
      if (item.productId === comboId) throw Errors.badRequest('INVALID_COMBO_ITEM', 'A combo cannot contain itself');
      if (new Prisma.Decimal(item.quantity).lte(0)) throw Errors.badRequest('INVALID_COMBO_ITEM', 'quantity must be greater than 0');
      const key = `${item.productId}:${item.variantId ?? ''}`;
      if (seen.has(key)) throw Errors.badRequest('INVALID_COMBO_ITEM', 'The same item is listed twice; combine the quantities');
      seen.add(key);
    }
    const ids = [...new Set(items.map((i) => i.productId))];
    const products = await tx.product.findMany({
      where: { id: { in: ids }, organizationId: actor.organizationId, deletedAt: null },
      include: { variants: { select: { id: true } } },
    });
    const byId = new Map(products.map((p) => [p.id, p]));
    for (const item of items) {
      const p = byId.get(item.productId);
      if (!p) throw Errors.badRequest('INVALID_COMBO_ITEM', `Product ${item.productId} not found`);
      if (p.isCombo) throw Errors.badRequest('INVALID_COMBO_ITEM', `"${p.name}" is itself a combo; combos cannot be nested`);
      if (item.variantId && !p.variants.some((v) => v.id === item.variantId)) {
        throw Errors.badRequest('INVALID_COMBO_ITEM', `Variant ${item.variantId} does not belong to "${p.name}"`);
      }
    }
    if (items.length) {
      await tx.comboItem.createMany({
        data: items.map((i) => ({ comboProductId: comboId, productId: i.productId, variantId: i.variantId ?? null, quantity: i.quantity })),
      });
    }
  }

  // ───────────── Branch pricing & availability ─────────────

  /**
   * Replaces every override of this product in one branch. Changing an override price (or
   * adding/removing one) needs `menu.price.update` in that branch; availability-only rows need
   * just `menu.availability.update`, which the route already enforces.
   */
  async setBranchPrices(actor: AuthPrincipal, productId: string, dto: SetBranchPricesDto, meta: RequestMeta) {
    const product = await this.get(actor, productId);
    const variantIds = new Set(product.variants.map((v) => v.id));
    const seen = new Set<string>();
    for (const o of dto.overrides) {
      if (o.variantId && !variantIds.has(o.variantId)) throw Errors.badRequest('INVALID_VARIANT', `Variant ${o.variantId} does not belong to this product`);
      const k = o.variantId ?? '';
      if (seen.has(k)) throw Errors.badRequest('DUPLICATE_OVERRIDE', 'Each variant (or the product itself) may appear only once');
      seen.add(k);
    }

    await this.prisma.$transaction(async (tx) => {
      const before = await tx.branchProductPrice.findMany({ where: { productId, branchId: dto.branchId } });
      const priceOf = (rows: { variantId: string | null; price: Prisma.Decimal | string | null }[]) =>
        new Map(rows.filter((r) => r.price !== null).map((r) => [r.variantId ?? '', new Prisma.Decimal(r.price!).toFixed(2)]));
      const oldPrices = priceOf(before);
      const newPrices = priceOf(dto.overrides);
      const priceChanged =
        oldPrices.size !== newPrices.size || [...newPrices].some(([k, v]) => oldPrices.get(k) !== v);
      if (priceChanged) requirePriceRight(actor, dto.branchId);

      await tx.branchProductPrice.deleteMany({ where: { productId, branchId: dto.branchId } });
      if (dto.overrides.length) {
        await tx.branchProductPrice.createMany({
          data: dto.overrides.map((o) => ({
            branchId: dto.branchId,
            productId,
            variantId: o.variantId ?? null,
            price: o.price,
            isAvailable: o.isAvailable ?? true,
            updatedById: actor.userId,
          })),
        });
      }
      await this.audit.record(
        {
          organizationId: actor.organizationId,
          branchId: dto.branchId,
          actorUserId: actor.userId,
          action: priceChanged ? 'product.branch_price_changed' : 'product.branch_availability_changed',
          entityType: 'product',
          entityId: productId,
          before: { overrides: before },
          after: { overrides: dto.overrides },
          meta,
        },
        tx,
      );
    });
    return this.branchPrices(actor, productId, dto.branchId);
  }

  /** "86" an item: organization-wide (no branchId) or in one branch only. */
  async setAvailability(actor: AuthPrincipal, productId: string, dto: SetAvailabilityDto, meta: RequestMeta) {
    const product = await this.get(actor, productId);
    await this.prisma.$transaction(async (tx) => {
      if (!dto.branchId) {
        await tx.product.update({ where: { id: productId }, data: { isAvailable: dto.isAvailable } });
      } else {
        // Keep any branch price; only flip the product-level availability row.
        const existing = await tx.branchProductPrice.findFirst({ where: { branchId: dto.branchId, productId, variantId: null } });
        if (existing) {
          await tx.branchProductPrice.update({ where: { id: existing.id }, data: { isAvailable: dto.isAvailable, updatedById: actor.userId } });
        } else {
          await tx.branchProductPrice.create({
            data: { branchId: dto.branchId, productId, variantId: null, price: null, isAvailable: dto.isAvailable, updatedById: actor.userId },
          });
        }
      }
      await this.audit.record(
        {
          organizationId: actor.organizationId,
          branchId: dto.branchId ?? null,
          actorUserId: actor.userId,
          action: dto.isAvailable ? 'product.made_available' : 'product.made_unavailable',
          entityType: 'product',
          entityId: productId,
          before: { isAvailable: product.isAvailable },
          after: { isAvailable: dto.isAvailable, branchId: dto.branchId ?? null },
          meta,
        },
        tx,
      );
    });
    return dto.branchId ? { productId, branchId: dto.branchId, isAvailable: dto.isAvailable } : this.get(actor, productId);
  }

  // ───────────── Image ─────────────

  async uploadImage(actor: AuthPrincipal, productId: string, file: UploadedImage | undefined, meta: RequestMeta) {
    const before = await this.get(actor, productId);
    if (!file?.buffer?.length) throw Errors.badRequest('FILE_REQUIRED', 'Attach the image as multipart field "image"');
    const type = sniffImage(file.buffer);
    if (!type) throw Errors.unprocessable('UNSUPPORTED_IMAGE', 'Only JPEG, PNG or WebP images are accepted');
    const key = `${actor.organizationId}/products/${randomUUID()}.${type.ext}`;
    const imageUrl = await this.storage.put(key, file.buffer, type.contentType);
    await this.prisma.$transaction(async (tx) => {
      await tx.product.update({ where: { id: productId }, data: { imageUrl } });
      await this.audit.record(
        {
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: 'product.image_uploaded',
          entityType: 'product',
          entityId: productId,
          before: { imageUrl: before.imageUrl },
          after: { imageUrl, bytes: file.buffer.length, contentType: type.contentType },
          meta,
        },
        tx,
      );
    });
    return this.get(actor, productId);
  }

  // ───────────── Guards on referenced rows ─────────────

  private async assertCategory(actor: AuthPrincipal, categoryId: string) {
    const c = await this.prisma.category.findFirst({ where: { id: categoryId, organizationId: actor.organizationId, deletedAt: null } });
    if (!c) throw Errors.badRequest('INVALID_CATEGORY', 'Category not found');
  }

  private async assertTaxRate(actor: AuthPrincipal, taxRateId: string) {
    const t = await this.prisma.taxRate.findFirst({ where: { id: taxRateId, organizationId: actor.organizationId, isActive: true } });
    if (!t) throw Errors.badRequest('INVALID_TAX_RATE', 'Tax rate not found or inactive');
  }

  private async assertModifierGroups(actor: AuthPrincipal, groupIds: string[]) {
    if (!groupIds.length) return;
    const n = await this.prisma.modifierGroup.count({ where: { id: { in: groupIds }, organizationId: actor.organizationId } });
    if (n !== new Set(groupIds).size) throw Errors.badRequest('INVALID_MODIFIER_GROUP', 'One or more add-on groups were not found');
  }
}

/** Validates names/defaults of variants given on product creation; the first becomes default if none is chosen. */
export function normaliseVariants(input: VariantInputDto[]) {
  const names = new Set<string>();
  for (const v of input) {
    const k = v.name.trim().toLowerCase();
    if (names.has(k)) throw Errors.badRequest('DUPLICATE_NAME', `Duplicate variant "${v.name}"`);
    names.add(k);
  }
  const defaults = input.filter((v) => v.isDefault).length;
  if (defaults > 1) throw Errors.badRequest('INVALID_DEFAULT', 'Only one variant can be the default');
  return input.map((v, i) => ({
    name: v.name.trim(),
    price: v.price,
    isDefault: defaults === 0 ? i === 0 : v.isDefault === true,
    sortOrder: v.sortOrder ?? i,
  }));
}
