import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/app-error';
import type { RequestMeta } from '../../common/http/request-meta';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthPrincipal } from '../auth/principal';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/menu.dto';

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(actor: AuthPrincipal) {
    return this.prisma.category.findMany({
      where: { organizationId: actor.organizationId, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { products: { where: { deletedAt: null } } } } },
    });
  }

  async get(actor: AuthPrincipal, id: string) {
    const c = await this.prisma.category.findFirst({ where: { id, organizationId: actor.organizationId, deletedAt: null } });
    if (!c) throw Errors.notFound('Category');
    return c;
  }

  async create(actor: AuthPrincipal, dto: CreateCategoryDto, meta: RequestMeta) {
    if (dto.parentId) await this.get(actor, dto.parentId);
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.category.create({
        data: { organizationId: actor.organizationId, name: dto.name.trim(), parentId: dto.parentId, sortOrder: dto.sortOrder ?? 0 },
      });
      await this.audit.record(
        { organizationId: actor.organizationId, actorUserId: actor.userId, action: 'category.created', entityType: 'category', entityId: row.id, after: row, meta },
        tx,
      );
      return row;
    });
  }

  async update(actor: AuthPrincipal, id: string, dto: UpdateCategoryDto, meta: RequestMeta) {
    const before = await this.get(actor, id);
    if (dto.parentId) {
      if (dto.parentId === id) throw Errors.badRequest('INVALID_PARENT', 'A category cannot be its own parent');
      await this.assertNoCycle(actor, id, dto.parentId);
    }
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.category.update({
        where: { id },
        data: { name: dto.name?.trim(), parentId: dto.parentId, sortOrder: dto.sortOrder, isActive: dto.isActive },
      });
      await this.audit.record(
        { organizationId: actor.organizationId, actorUserId: actor.userId, action: 'category.updated', entityType: 'category', entityId: id, before, after, meta },
        tx,
      );
      return after;
    });
  }

  async remove(actor: AuthPrincipal, id: string, meta: RequestMeta): Promise<void> {
    const before = await this.get(actor, id);
    const [products, children] = await Promise.all([
      this.prisma.product.count({ where: { categoryId: id, deletedAt: null } }),
      this.prisma.category.count({ where: { parentId: id, deletedAt: null } }),
    ]);
    if (products || children) {
      throw Errors.conflict('CATEGORY_NOT_EMPTY', 'Move or delete its products and sub-categories first', { products, children });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.category.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
      await this.audit.record(
        { organizationId: actor.organizationId, actorUserId: actor.userId, action: 'category.deleted', entityType: 'category', entityId: id, before, meta },
        tx,
      );
    });
  }

  private async assertNoCycle(actor: AuthPrincipal, id: string, parentId: string) {
    let cursor: string | null = parentId;
    for (let depth = 0; cursor && depth < 20; depth++) {
      if (cursor === id) throw Errors.badRequest('INVALID_PARENT', 'This would create a category loop');
      const parent: { parentId: string | null } = await this.get(actor, cursor);
      cursor = parent.parentId;
    }
  }
}
