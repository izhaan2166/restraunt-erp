import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/app-error';
import type { RequestMeta } from '../../common/http/request-meta';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthPrincipal } from '../auth/principal';
import { CreateModifierGroupDto, ModifierInputDto, UpdateModifierDto, UpdateModifierGroupDto } from './dto/menu.dto';
import { requirePriceRight } from './price-rights';

@Injectable()
export class ModifiersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(actor: AuthPrincipal) {
    return this.prisma.modifierGroup.findMany({
      where: { organizationId: actor.organizationId },
      orderBy: { name: 'asc' },
      include: { modifiers: { orderBy: { name: 'asc' } } },
    });
  }

  async getGroup(actor: AuthPrincipal, id: string) {
    const g = await this.prisma.modifierGroup.findFirst({
      where: { id, organizationId: actor.organizationId },
      include: { modifiers: { orderBy: { name: 'asc' } } },
    });
    if (!g) throw Errors.notFound('Modifier group');
    return g;
  }

  async createGroup(actor: AuthPrincipal, dto: CreateModifierGroupDto, meta: RequestMeta) {
    const min = dto.minSelect ?? 0;
    const max = dto.maxSelect ?? 1;
    if (max < min) throw Errors.badRequest('INVALID_SELECTION_RANGE', 'maxSelect must be ≥ minSelect');
    assertUniqueNames(dto.modifiers ?? []);
    const id = await this.prisma.$transaction(async (tx) => {
      const g = await tx.modifierGroup.create({
        data: {
          organizationId: actor.organizationId,
          name: dto.name.trim(),
          minSelect: min,
          maxSelect: max,
          modifiers: { create: (dto.modifiers ?? []).map((m) => ({ name: m.name.trim(), price: m.price })) },
        },
        include: { modifiers: true },
      });
      await this.audit.record(
        { organizationId: actor.organizationId, actorUserId: actor.userId, action: 'modifier_group.created', entityType: 'modifier_group', entityId: g.id, after: g, meta },
        tx,
      );
      return g.id;
    });
    return this.getGroup(actor, id);
  }

  async updateGroup(actor: AuthPrincipal, id: string, dto: UpdateModifierGroupDto, meta: RequestMeta) {
    const before = await this.getGroup(actor, id);
    const min = dto.minSelect ?? before.minSelect;
    const max = dto.maxSelect ?? before.maxSelect;
    if (max < min) throw Errors.badRequest('INVALID_SELECTION_RANGE', 'maxSelect must be ≥ minSelect');
    await this.prisma.$transaction(async (tx) => {
      const after = await tx.modifierGroup.update({ where: { id }, data: { name: dto.name?.trim(), minSelect: min, maxSelect: max } });
      await this.audit.record(
        { organizationId: actor.organizationId, actorUserId: actor.userId, action: 'modifier_group.updated', entityType: 'modifier_group', entityId: id, before, after, meta },
        tx,
      );
    });
    return this.getGroup(actor, id);
  }

  async addModifier(actor: AuthPrincipal, groupId: string, dto: ModifierInputDto, meta: RequestMeta) {
    await this.getGroup(actor, groupId);
    await this.prisma.$transaction(async (tx) => {
      const m = await tx.modifier.create({ data: { groupId, name: dto.name.trim(), price: dto.price } });
      await this.audit.record(
        { organizationId: actor.organizationId, actorUserId: actor.userId, action: 'modifier.created', entityType: 'modifier', entityId: m.id, after: m, meta },
        tx,
      );
    });
    return this.getGroup(actor, groupId);
  }

  async updateModifier(actor: AuthPrincipal, id: string, dto: UpdateModifierDto, meta: RequestMeta) {
    const before = await this.prisma.modifier.findFirst({ where: { id, group: { organizationId: actor.organizationId } } });
    if (!before) throw Errors.notFound('Modifier');
    if (dto.price !== undefined && !before.price.equals(dto.price)) requirePriceRight(actor);
    await this.prisma.$transaction(async (tx) => {
      const after = await tx.modifier.update({ where: { id }, data: { name: dto.name?.trim(), price: dto.price, isActive: dto.isActive } });
      await this.audit.record(
        {
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: dto.price !== undefined && !before.price.equals(dto.price) ? 'modifier.price_changed' : 'modifier.updated',
          entityType: 'modifier',
          entityId: id,
          before,
          after,
          meta,
        },
        tx,
      );
    });
    return this.getGroup(actor, before.groupId);
  }
}

function assertUniqueNames(items: { name: string }[]) {
  const seen = new Set<string>();
  for (const i of items) {
    const k = i.name.trim().toLowerCase();
    if (seen.has(k)) throw Errors.badRequest('DUPLICATE_NAME', `Duplicate name "${i.name}"`);
    seen.add(k);
  }
}
