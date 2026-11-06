import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/app-error';
import type { RequestMeta } from '../../common/http/request-meta';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthPrincipal } from '../auth/principal';
import { SUPER_ADMIN } from './default-roles';
import { isPermissionCode } from './permissions.catalog';
import { CreateRoleDto, UpdateRolePermissionsDto } from './dto/role.dto';

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  listPermissions() {
    return this.prisma.permission.findMany({ orderBy: [{ module: 'asc' }, { code: 'asc' }] });
  }

  async list(organizationId: string) {
    const roles = await this.prisma.role.findMany({
      where: { organizationId },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      include: {
        rolePermissions: { select: { permission: { select: { code: true } } } },
        _count: { select: { userRoles: true } },
      },
    });
    return roles.map((r) => this.present(r));
  }

  async get(organizationId: string, id: string) {
    const role = await this.prisma.role.findFirst({
      where: { id, organizationId },
      include: {
        rolePermissions: { select: { permission: { select: { code: true } } } },
        _count: { select: { userRoles: true } },
      },
    });
    if (!role) throw Errors.notFound('Role');
    return this.present(role);
  }

  async create(actor: AuthPrincipal, dto: CreateRoleDto, meta: RequestMeta) {
    const permissionIds = await this.authorizeGrant(actor, dto.permissions);
    return this.prisma.$transaction(async (tx) => {
      const role = await tx.role.create({
        data: {
          organizationId: actor.organizationId,
          key: dto.key,
          name: dto.name,
          description: dto.description,
          isSystem: false,
          rolePermissions: { create: permissionIds.map((permissionId) => ({ permissionId, grantedById: actor.userId })) },
        },
      });
      await this.audit.record(
        {
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: 'role.created',
          entityType: 'role',
          entityId: role.id,
          after: { key: dto.key, name: dto.name, permissions: [...dto.permissions].sort() },
          meta,
        },
        tx,
      );
      return { id: role.id };
    }).then(({ id }) => this.get(actor.organizationId, id));
  }

  async replacePermissions(actor: AuthPrincipal, roleId: string, dto: UpdateRolePermissionsDto, meta: RequestMeta) {
    const role = await this.get(actor.organizationId, roleId);
    if (role.key === SUPER_ADMIN) {
      throw Errors.forbidden('ROLE_IMMUTABLE', 'The Super Admin role always has every permission and cannot be edited');
    }
    // You may not add *or remove* permissions you do not hold yourself.
    const before = new Set(role.permissions);
    const after = new Set(dto.permissions);
    const changed = [...after].filter((p) => !before.has(p)).concat([...before].filter((p) => !after.has(p)));
    await this.authorizeGrant(actor, changed);
    const permissionIds = await this.resolvePermissionIds(dto.permissions);

    await this.prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId } });
      await tx.rolePermission.createMany({
        data: permissionIds.map((permissionId) => ({ roleId, permissionId, grantedById: actor.userId })),
      });
      await tx.role.update({ where: { id: roleId }, data: { updatedAt: new Date() } });
      await this.audit.record(
        {
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: 'role.permissions_updated',
          entityType: 'role',
          entityId: roleId,
          before: { permissions: [...before].sort() },
          after: { permissions: [...after].sort() },
          meta,
        },
        tx,
      );
    });
    return this.get(actor.organizationId, roleId);
  }

  async remove(actor: AuthPrincipal, roleId: string, meta: RequestMeta): Promise<void> {
    const role = await this.get(actor.organizationId, roleId);
    if (role.isSystem) throw Errors.forbidden('ROLE_IMMUTABLE', 'System roles cannot be deleted');
    if (role.assignedUsers > 0) {
      throw Errors.conflict('ROLE_IN_USE', 'Remove this role from all users before deleting it');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.role.delete({ where: { id: roleId } });
      await this.audit.record(
        {
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: 'role.deleted',
          entityType: 'role',
          entityId: roleId,
          before: role,
          meta,
        },
        tx,
      );
    });
  }

  /** Actor must hold (organization-wide) every permission they hand out. */
  private async authorizeGrant(actor: AuthPrincipal, codes: string[]): Promise<string[]> {
    const ids = await this.resolvePermissionIds(codes);
    const missing = actor.permissions.missingForGrant(codes, null);
    if (missing.length) {
      throw Errors.forbidden('PRIVILEGE_ESCALATION', 'You cannot grant or revoke permissions you do not hold', { missing });
    }
    return ids;
  }

  private async resolvePermissionIds(codes: string[]): Promise<string[]> {
    const unknown = codes.filter((c) => !isPermissionCode(c));
    if (unknown.length) throw Errors.badRequest('UNKNOWN_PERMISSION', 'Unknown permission codes', { unknown });
    if (!codes.length) return [];
    const rows = await this.prisma.permission.findMany({ where: { code: { in: codes } }, select: { id: true } });
    if (rows.length !== codes.length) throw Errors.badRequest('UNKNOWN_PERMISSION', 'Permission catalog is out of sync');
    return rows.map((r) => r.id);
  }

  private present(r: {
    id: string;
    key: string;
    name: string;
    description: string | null;
    isSystem: boolean;
    createdAt: Date;
    updatedAt: Date;
    rolePermissions: { permission: { code: string } }[];
    _count: { userRoles: number };
  }) {
    return {
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      isSystem: r.isSystem,
      permissions: r.rolePermissions.map((rp) => rp.permission.code).sort(),
      assignedUsers: r._count.userRoles,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }
}
