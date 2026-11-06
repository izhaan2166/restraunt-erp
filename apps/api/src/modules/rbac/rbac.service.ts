import { Injectable } from '@nestjs/common';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { PermissionSet, RoleGrant } from './permission-resolver';

@Injectable()
export class RbacService {
  constructor(private readonly prisma: PrismaService) {}

  /** Loads every role assignment of the user (one query) as a PermissionSet. */
  async loadPermissionSet(userId: string, organizationId: string, tx?: Tx): Promise<PermissionSet> {
    const db = tx ?? this.prisma;
    const rows = await db.userRole.findMany({
      where: { userId, organizationId },
      select: {
        branchId: true,
        role: {
          select: {
            id: true,
            key: true,
            rolePermissions: { select: { permission: { select: { code: true } } } },
          },
        },
      },
    });
    const grants: RoleGrant[] = rows.map((r) => ({
      roleId: r.role.id,
      roleKey: r.role.key,
      branchId: r.branchId,
      permissions: r.role.rolePermissions.map((rp) => rp.permission.code),
    }));
    return new PermissionSet(grants);
  }
}
