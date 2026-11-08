import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Errors } from '../../common/errors/app-error';
import { Paginated } from '../../common/dto/pagination';
import type { RequestMeta } from '../../common/http/request-meta';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { PASSWORD_POLICY, PasswordService, checkPasswordPolicy } from '../auth/password.service';
import type { AuthPrincipal } from '../auth/principal';
import { SUPER_ADMIN } from '../rbac/default-roles';
import type { PermissionCode } from '../rbac/permissions.catalog';
import { CreateUserDto, ListUsersQuery, RoleAssignmentDto, UpdateUserDto } from './dto/user.dto';

const userInclude = {
  userRoles: {
    include: { role: { select: { id: true, key: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.UserInclude;

type UserWithRoles = Prisma.UserGetPayload<{ include: typeof userInclude }>;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  async list(actor: AuthPrincipal, branchId: string | null, q: ListUsersQuery) {
    const where: Prisma.UserWhereInput = {
      organizationId: actor.organizationId,
      deletedAt: null,
      ...(q.isActive === undefined ? {} : { isActive: q.isActive }),
      ...(branchId ? { userRoles: { some: { OR: [{ branchId }, { branchId: null }] } } } : {}),
      ...(q.search
        ? {
            OR: [
              { fullName: { contains: q.search, mode: 'insensitive' } },
              { email: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        include: userInclude,
        orderBy: { createdAt: q.order },
        skip: q.skip,
        take: q.pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);
    return new Paginated(rows.map(present), total, q);
  }

  async get(actor: AuthPrincipal, id: string) {
    return present(await this.loadVisible(actor, id, 'users.read'));
  }

  async create(actor: AuthPrincipal, dto: CreateUserDto, meta: RequestMeta) {
    if (!checkPasswordPolicy(dto.password)) throw Errors.badRequest('WEAK_PASSWORD', PASSWORD_POLICY);
    if (dto.roles.length === 0) throw Errors.badRequest('ROLE_REQUIRED', 'Assign at least one role');
    // Creating a user is allowed in every scope the new user will get access to.
    for (const a of dto.roles) this.requireIn(actor, 'users.create', a.branchId);
    const exists = await this.prisma.user.findUnique({ where: { email: dto.email }, select: { id: true } });
    if (exists) throw Errors.conflict('EMAIL_TAKEN', 'A user with this email already exists');

    const passwordHash = await this.passwords.hash(dto.password);
    const id = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          organizationId: actor.organizationId,
          email: dto.email,
          fullName: dto.fullName,
          phone: dto.phone,
          passwordHash,
          createdById: actor.userId,
        },
      });
      for (const a of dto.roles) await this.assignRole(tx, actor, user.id, a);
      await this.audit.record(
        {
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: 'user.created',
          entityType: 'user',
          entityId: user.id,
          after: { email: user.email, fullName: user.fullName, roles: dto.roles },
          meta,
        },
        tx,
      );
      return user.id;
    });
    return this.get(actor, id);
  }

  async update(actor: AuthPrincipal, id: string, dto: UpdateUserDto, meta: RequestMeta) {
    const target = await this.loadVisible(actor, id, 'users.read');
    this.requireOverTarget(actor, target, 'users.update');
    const deactivating = dto.isActive === false && target.isActive;
    if (dto.isActive !== undefined && dto.isActive !== target.isActive) {
      this.requireOverTarget(actor, target, 'users.deactivate');
      if (target.id === actor.userId) throw Errors.badRequest('CANNOT_DEACTIVATE_SELF', 'You cannot deactivate yourself');
      if (deactivating) await this.assertNotLastSuperAdmin(this.prisma, target, null);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: { fullName: dto.fullName, phone: dto.phone, isActive: dto.isActive },
      });
      if (deactivating) await this.auth.revokeAllSessions(id, 'user_deactivated', tx);
      await this.audit.record(
        {
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: deactivating ? 'user.deactivated' : 'user.updated',
          entityType: 'user',
          entityId: id,
          before: { fullName: target.fullName, phone: target.phone, isActive: target.isActive },
          after: dto,
          meta,
        },
        tx,
      );
    });
    return this.get(actor, id);
  }

  async addRole(actor: AuthPrincipal, userId: string, dto: RoleAssignmentDto, meta: RequestMeta) {
    await this.loadVisible(actor, userId, 'users.read');
    await this.prisma.$transaction(async (tx) => {
      const assignmentId = await this.assignRole(tx, actor, userId, dto);
      await this.audit.record(
        {
          organizationId: actor.organizationId,
          branchId: dto.branchId,
          actorUserId: actor.userId,
          action: 'user.role_assigned',
          entityType: 'user',
          entityId: userId,
          after: { assignmentId, roleId: dto.roleId, branchId: dto.branchId },
          meta,
        },
        tx,
      );
    });
    return this.get(actor, userId);
  }

  async removeRole(actor: AuthPrincipal, userId: string, assignmentId: string, meta: RequestMeta) {
    const target = await this.loadVisible(actor, userId, 'users.read');
    const assignment = await this.prisma.userRole.findFirst({
      where: { id: assignmentId, userId, organizationId: actor.organizationId },
      include: { role: { include: { rolePermissions: { include: { permission: true } } } } },
    });
    if (!assignment) throw Errors.notFound('Role assignment');
    this.requireIn(actor, 'users.assign_roles', assignment.branchId);
    this.requireCanGrant(actor, assignment.role.key, assignment.role.rolePermissions.map((rp) => rp.permission.code), assignment.branchId);
    if (assignment.role.key === SUPER_ADMIN) await this.assertNotLastSuperAdmin(this.prisma, target, assignment.id);

    await this.prisma.$transaction(async (tx) => {
      await tx.userRole.delete({ where: { id: assignment.id } });
      await this.audit.record(
        {
          organizationId: actor.organizationId,
          branchId: assignment.branchId,
          actorUserId: actor.userId,
          action: 'user.role_removed',
          entityType: 'user',
          entityId: userId,
          before: { assignmentId, roleKey: assignment.role.key, branchId: assignment.branchId },
          meta,
        },
        tx,
      );
    });
    return this.get(actor, userId);
  }

  // ───────────── authorization helpers ─────────────

  private async assignRole(tx: Tx, actor: AuthPrincipal, userId: string, dto: RoleAssignmentDto): Promise<string> {
    const branchId = dto.branchId ?? null;
    if (branchId) {
      const branch = await tx.branch.findFirst({
        where: { id: branchId, organizationId: actor.organizationId, deletedAt: null },
        select: { id: true },
      });
      if (!branch) throw Errors.notFound('Branch');
    }
    this.requireIn(actor, 'users.assign_roles', branchId);
    const role = await tx.role.findFirst({
      where: { id: dto.roleId, organizationId: actor.organizationId },
      include: { rolePermissions: { include: { permission: true } } },
    });
    if (!role) throw Errors.notFound('Role');
    if (role.key === SUPER_ADMIN && branchId) {
      throw Errors.badRequest('SUPER_ADMIN_ORG_WIDE', 'Super Admin can only be assigned organization-wide');
    }
    this.requireCanGrant(actor, role.key, role.rolePermissions.map((rp) => rp.permission.code), branchId);
    try {
      const row = await tx.userRole.create({
        data: { organizationId: actor.organizationId, userId, roleId: role.id, branchId, assignedById: actor.userId },
      });
      return row.id;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw Errors.conflict('ROLE_ALREADY_ASSIGNED', 'User already has this role for that branch');
      }
      throw e;
    }
  }

  private requireIn(actor: AuthPrincipal, permission: PermissionCode, branchId: string | null): void {
    if (!actor.permissions.has(permission, branchId)) {
      throw Errors.forbidden('MISSING_PERMISSION', 'You do not have permission to perform this action', {
        missing: [permission],
        branchId,
      });
    }
  }

  /** Anti-escalation: you can only grant/strip a role whose permissions you hold in that scope. */
  private requireCanGrant(actor: AuthPrincipal, roleKey: string, permissions: string[], branchId: string | null) {
    if (roleKey === SUPER_ADMIN && !actor.permissions.isSuperAdmin()) {
      throw Errors.forbidden('PRIVILEGE_ESCALATION', 'Only a Super Admin can grant or remove Super Admin');
    }
    const missing = actor.permissions.missingForGrant(permissions, branchId);
    if (missing.length) {
      throw Errors.forbidden('PRIVILEGE_ESCALATION', 'This role has permissions you do not hold', { missing });
    }
  }

  /** Acting on a user needs the permission in every scope where that user has a role. */
  private requireOverTarget(actor: AuthPrincipal, target: UserWithRoles, permission: PermissionCode): void {
    if (target.userRoles.some((ur) => ur.role.key === SUPER_ADMIN) && !actor.permissions.isSuperAdmin()) {
      if (target.id !== actor.userId) {
        throw Errors.forbidden('PRIVILEGE_ESCALATION', 'Only a Super Admin can modify a Super Admin');
      }
    }
    const scopes = target.userRoles.length ? target.userRoles.map((ur) => ur.branchId) : [null];
    for (const scope of new Set(scopes)) this.requireIn(actor, permission, scope);
  }

  /**
   * Users outside the actor's reach are reported as "not found" so their existence is not leaked
   * across organizations or branches.
   */
  private async loadVisible(actor: AuthPrincipal, id: string, permission: PermissionCode): Promise<UserWithRoles> {
    const user = await this.prisma.user.findFirst({
      where: { id, organizationId: actor.organizationId, deletedAt: null },
      include: userInclude,
    });
    if (!user) throw Errors.notFound('User');
    if (user.id === actor.userId) return user;
    const where = actor.permissions.branchesWith(permission);
    if (where === 'ALL') return user;
    const visible = user.userRoles.some((ur) => ur.branchId !== null && where.includes(ur.branchId));
    if (!visible) throw Errors.notFound('User');
    return user;
  }

  private async assertNotLastSuperAdmin(db: PrismaService | Tx, target: UserWithRoles, removingAssignmentId: string | null) {
    const isSuper = target.userRoles.some(
      (ur) => ur.role.key === SUPER_ADMIN && (removingAssignmentId === null || ur.id === removingAssignmentId),
    );
    if (!isSuper) return;
    const others = await db.userRole.count({
      where: {
        organizationId: target.organizationId,
        role: { key: SUPER_ADMIN },
        userId: { not: target.id },
        user: { isActive: true, deletedAt: null },
      },
    });
    if (others === 0) {
      throw Errors.conflict('LAST_SUPER_ADMIN', 'The organization must keep at least one active Super Admin');
    }
  }
}

function present(u: UserWithRoles) {
  return {
    id: u.id,
    email: u.email,
    fullName: u.fullName,
    phone: u.phone,
    isActive: u.isActive,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
    roles: u.userRoles.map((ur) => ({
      assignmentId: ur.id,
      roleId: ur.role.id,
      roleKey: ur.role.key,
      roleName: ur.role.name,
      branchId: ur.branchId,
    })),
  };
}
