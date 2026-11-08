import type { PrismaClient } from '@prisma/client';
import type { Tx } from '../../prisma/prisma.service';
import { DEFAULT_ROLES } from './default-roles';
import { ALL_PERMISSIONS, PERMISSIONS, moduleOf } from './permissions.catalog';

/** Upserts the permission catalog. Safe to run on every deploy. */
export async function syncPermissionCatalog(db: PrismaClient | Tx): Promise<void> {
  for (const code of ALL_PERMISSIONS) {
    await db.permission.upsert({
      where: { code },
      create: { code, module: moduleOf(code), description: PERMISSIONS[code] },
      update: { module: moduleOf(code), description: PERMISSIONS[code] },
    });
  }
}

/**
 * Creates the default system roles for a new organization. Existing roles are left untouched,
 * so an organization's customised permissions survive re-runs.
 */
export async function provisionDefaultRoles(db: PrismaClient | Tx, organizationId: string): Promise<Map<string, string>> {
  const perms = await db.permission.findMany({ select: { id: true, code: true } });
  const idByCode = new Map(perms.map((p) => [p.code, p.id]));
  const roleIds = new Map<string, string>();
  for (const tpl of DEFAULT_ROLES) {
    const existing = await db.role.findUnique({ where: { organizationId_key: { organizationId, key: tpl.key } } });
    if (existing) {
      roleIds.set(tpl.key, existing.id);
      continue;
    }
    const role = await db.role.create({
      data: {
        organizationId,
        key: tpl.key,
        name: tpl.name,
        description: tpl.description,
        isSystem: true,
        rolePermissions: {
          create: tpl.permissions.map((code) => {
            const permissionId = idByCode.get(code);
            if (!permissionId) throw new Error(`Permission ${code} missing; run syncPermissionCatalog first`);
            return { permissionId };
          }),
        },
      },
    });
    roleIds.set(tpl.key, role.id);
  }
  return roleIds;
}
