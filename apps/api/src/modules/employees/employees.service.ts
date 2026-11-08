import { Injectable } from '@nestjs/common';
import { Employee, Prisma } from '@prisma/client';
import { requireInBranch } from '../../common/auth/branch-access';
import { dateOnly } from '../../common/dates';
import { Paginated } from '../../common/dto/pagination';
import { Errors } from '../../common/errors/app-error';
import type { RequestMeta } from '../../common/http/request-meta';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthPrincipal } from '../auth/principal';
import { CreateEmployeeDto, ListEmployeesQuery, UpdateEmployeeDto } from './dto/employees.dto';

type Tx = Prisma.TransactionClient;
const Dec = Prisma.Decimal;

const INCLUDE = {
  primaryBranch: { select: { id: true, name: true, code: true } },
  user: {
    select: {
      id: true,
      email: true,
      isActive: true,
      lastLoginAt: true,
      userRoles: { select: { branchId: true, role: { select: { key: true, name: true } } } },
    },
  },
} satisfies Prisma.EmployeeInclude;

type EmployeeRow = Prisma.EmployeeGetPayload<{ include: typeof INCLUDE }>;

@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Employees of the branches the caller may see (organization-wide roles see everyone). */
  async list(actor: AuthPrincipal, q: ListEmployeesQuery) {
    const visible = this.visibleBranches(actor);
    if (q.branchId && visible !== 'ALL' && !visible.includes(q.branchId)) requireInBranch(actor, q.branchId, ['employees.read'], 'Branch');
    const where: Prisma.EmployeeWhereInput = {
      organizationId: actor.organizationId,
      deletedAt: null,
      isActive: q.includeInactive ? undefined : true,
      primaryBranchId: q.branchId ?? (visible === 'ALL' ? undefined : { in: visible }),
      ...(q.search
        ? { OR: [{ fullName: { contains: q.search, mode: 'insensitive' } }, { employeeCode: { contains: q.search, mode: 'insensitive' } }, { phone: { contains: q.search } }] }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.employee.findMany({ where, include: INCLUDE, orderBy: { fullName: q.order }, skip: q.skip, take: q.pageSize }),
      this.prisma.employee.count({ where }),
    ]);
    return new Paginated(rows.map((r) => this.present(actor, r)), total, q);
  }

  async get(actor: AuthPrincipal, id: string) {
    const e = await this.prisma.employee.findFirst({ where: { id, organizationId: actor.organizationId, deletedAt: null }, include: INCLUDE });
    if (!e) throw Errors.notFound('Employee');
    this.assertCan(actor, e.primaryBranchId, 'employees.read');
    return this.present(actor, e);
  }

  async me(actor: AuthPrincipal) {
    const e = await this.prisma.employee.findFirst({ where: { userId: actor.userId, organizationId: actor.organizationId, deletedAt: null }, include: INCLUDE });
    if (!e) throw Errors.notFound('Employee profile');
    return { ...e, monthlySalary: e.monthlySalary };
  }

  async create(actor: AuthPrincipal, dto: CreateEmployeeDto, meta: RequestMeta) {
    this.assertCan(actor, dto.primaryBranchId ?? null, 'employees.manage');
    return this.prisma.$transaction(async (tx) => {
      if (dto.primaryBranchId) await this.branchOrThrow(tx, actor.organizationId, dto.primaryBranchId);
      if (dto.userId) await this.assertUserFree(tx, actor.organizationId, dto.userId, null);
      const code = dto.employeeCode.toUpperCase();
      const clash = await tx.employee.findFirst({ where: { organizationId: actor.organizationId, employeeCode: code } });
      if (clash) throw Errors.conflict('DUPLICATE_EMPLOYEE_CODE', `Employee code ${code} is already used by ${clash.fullName}`);
      const e = await tx.employee.create({
        data: {
          organizationId: actor.organizationId,
          employeeCode: code,
          fullName: dto.fullName.trim(),
          phone: dto.phone ?? null,
          email: dto.email ?? null,
          designation: dto.designation?.trim() || null,
          joiningDate: dto.joiningDate ? dateOnly(dto.joiningDate) : null,
          monthlySalary: dto.monthlySalary ? new Dec(dto.monthlySalary) : null,
          primaryBranchId: dto.primaryBranchId ?? null,
          userId: dto.userId ?? null,
        },
        include: INCLUDE,
      });
      await this.log(tx, actor, e.primaryBranchId, 'employee.created', e.id, undefined, this.snapshot(e), meta);
      return this.present(actor, e);
    });
  }

  async update(actor: AuthPrincipal, id: string, dto: UpdateEmployeeDto, meta: RequestMeta) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.employee.findFirst({ where: { id, organizationId: actor.organizationId, deletedAt: null } });
      if (!before) throw Errors.notFound('Employee');
      this.assertCan(actor, before.primaryBranchId, 'employees.manage');
      if (dto.primaryBranchId && dto.primaryBranchId !== before.primaryBranchId) {
        this.assertCan(actor, dto.primaryBranchId, 'employees.manage');
        await this.branchOrThrow(tx, actor.organizationId, dto.primaryBranchId);
      }
      if (dto.userId) await this.assertUserFree(tx, actor.organizationId, dto.userId, id);
      const after = await tx.employee.update({
        where: { id },
        data: {
          fullName: dto.fullName?.trim(),
          phone: dto.phone,
          email: dto.email,
          designation: dto.designation?.trim(),
          joiningDate: dto.joiningDate ? dateOnly(dto.joiningDate) : undefined,
          monthlySalary: dto.monthlySalary ? new Dec(dto.monthlySalary) : undefined,
          primaryBranchId: dto.primaryBranchId,
          userId: dto.userId,
          isActive: dto.isActive,
        },
        include: INCLUDE,
      });
      await this.log(tx, actor, after.primaryBranchId, 'employee.updated', id, this.snapshot(before), this.snapshot(after), meta);
      return this.present(actor, after);
    });
  }

  /** Removes the profile from lists; attendance and the history stay. */
  async remove(actor: AuthPrincipal, id: string, meta: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      const e = await tx.employee.findFirst({ where: { id, organizationId: actor.organizationId, deletedAt: null } });
      if (!e) throw Errors.notFound('Employee');
      this.assertCan(actor, e.primaryBranchId, 'employees.manage');
      const open = await tx.attendance.findFirst({ where: { employeeId: id, clockInAt: { not: null }, clockOutAt: null } });
      if (open) throw Errors.conflict('EMPLOYEE_CLOCKED_IN', `${e.fullName} is clocked in; clock them out first`);
      await tx.employee.update({ where: { id }, data: { deletedAt: new Date(), isActive: false, userId: null } });
      await this.log(tx, actor, e.primaryBranchId, 'employee.deleted', id, this.snapshot(e), undefined, meta);
    });
  }

  /** Login sessions (sign-in, last activity, sign-out) and the latest recorded actions of the employee's account. */
  async activity(actor: AuthPrincipal, id: string) {
    const e = await this.get(actor, id);
    if (!e.userId) return { employeeId: id, sessions: [], actions: [] };
    const [sessions, actions] = await Promise.all([
      this.prisma.session.findMany({
        where: { userId: e.userId },
        orderBy: { createdAt: 'desc' },
        take: 30,
        select: { id: true, createdAt: true, lastUsedAt: true, revokedAt: true, revokeReason: true, expiresAt: true, ip: true, userAgent: true },
      }),
      this.prisma.auditLog.findMany({
        where: { organizationId: actor.organizationId, actorUserId: e.userId },
        orderBy: { id: 'desc' },
        take: 50,
        select: { action: true, entityType: true, entityId: true, branchId: true, createdAt: true },
      }),
    ]);
    return {
      employeeId: id,
      sessions: sessions.map((s) => ({ ...s, loggedInAt: s.createdAt, loggedOutAt: s.revokedAt, active: !s.revokedAt && s.expiresAt > new Date() })),
      actions,
    };
  }

  // ───────────── Helpers ─────────────

  /** Salary is shown only to people who manage the employee. */
  private present(actor: AuthPrincipal, e: EmployeeRow) {
    const canManage = e.primaryBranchId ? actor.permissions.has('employees.manage', e.primaryBranchId) : actor.permissions.accessibleBranches() === 'ALL' && actor.permissions.has('employees.manage', null);
    return { ...e, monthlySalary: canManage ? e.monthlySalary : undefined };
  }

  /** Employees without a branch are managed organization-wide. */
  private assertCan(actor: AuthPrincipal, branchId: string | null, permission: string) {
    if (branchId) return requireInBranch(actor, branchId, [permission], 'Employee');
    if (actor.permissions.accessibleBranches() !== 'ALL' || !actor.permissions.has(permission, null)) {
      throw Errors.forbidden('MISSING_PERMISSION', 'Employees without a branch are managed by organization-wide roles', { missing: [permission] });
    }
  }

  private visibleBranches(actor: AuthPrincipal): 'ALL' | string[] {
    const access = actor.permissions.accessibleBranches();
    if (access === 'ALL') return 'ALL';
    return access.filter((b) => actor.permissions.has('employees.read', b));
  }

  private async branchOrThrow(tx: Tx, organizationId: string, id: string) {
    const b = await tx.branch.findFirst({ where: { id, organizationId, deletedAt: null } });
    if (!b) throw Errors.badRequest('INVALID_BRANCH', 'Unknown branch');
  }

  private async assertUserFree(tx: Tx, organizationId: string, userId: string, employeeId: string | null) {
    const u = await tx.user.findFirst({ where: { id: userId, organizationId, deletedAt: null } });
    if (!u) throw Errors.badRequest('INVALID_USER', 'Unknown user account');
    const other = await tx.employee.findFirst({ where: { userId, NOT: employeeId ? { id: employeeId } : undefined } });
    if (other) throw Errors.conflict('USER_ALREADY_LINKED', `This login is already linked to ${other.fullName}`);
  }

  private snapshot(e: Employee) {
    return {
      employeeCode: e.employeeCode,
      fullName: e.fullName,
      phone: e.phone,
      email: e.email,
      designation: e.designation,
      joiningDate: e.joiningDate?.toISOString().slice(0, 10) ?? null,
      monthlySalary: e.monthlySalary,
      primaryBranchId: e.primaryBranchId,
      userId: e.userId,
      isActive: e.isActive,
    };
  }

  private log(tx: Tx, actor: AuthPrincipal, branchId: string | null, action: string, id: string, before: unknown, after: unknown, meta: RequestMeta) {
    return this.audit.record({ organizationId: actor.organizationId, branchId, actorUserId: actor.userId, action, entityType: 'employee', entityId: id, before, after, meta }, tx);
  }
}
