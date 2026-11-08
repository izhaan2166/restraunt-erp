import { ALL_PERMISSIONS } from './permissions.catalog';
import { SUPER_ADMIN } from './default-roles';

/** One role assignment of a user, with the role's permission codes. branchId null = all branches. */
export interface RoleGrant {
  roleId: string;
  roleKey: string;
  branchId: string | null;
  permissions: readonly string[];
}

/**
 * Pure permission logic, shared by guards and services so authorization rules live in one place.
 */
export class PermissionSet {
  constructor(private readonly grants: readonly RoleGrant[]) {}

  get assignments(): readonly RoleGrant[] {
    return this.grants;
  }

  isSuperAdmin(): boolean {
    return this.grants.some((g) => g.roleKey === SUPER_ADMIN && g.branchId === null);
  }

  /** Permissions that apply in `branchId`; with null only organization-wide grants count. */
  effective(branchId: string | null): Set<string> {
    const out = new Set<string>();
    for (const g of this.grants) {
      if (g.branchId !== null && g.branchId !== branchId) continue;
      const perms = g.roleKey === SUPER_ADMIN ? ALL_PERMISSIONS : g.permissions;
      for (const p of perms) out.add(p);
    }
    return out;
  }

  has(permission: string, branchId: string | null): boolean {
    return this.effective(branchId).has(permission);
  }

  hasAll(permissions: readonly string[], branchId: string | null): boolean {
    const eff = this.effective(branchId);
    return permissions.every((p) => eff.has(p));
  }

  /** 'ALL' when held organization-wide, otherwise the branch ids where it is held. */
  branchesWith(permission: string): 'ALL' | string[] {
    const ids = new Set<string>();
    for (const g of this.grants) {
      const holds = g.roleKey === SUPER_ADMIN || g.permissions.includes(permission);
      if (!holds) continue;
      if (g.branchId === null) return 'ALL';
      ids.add(g.branchId);
    }
    return [...ids];
  }

  /** Every branch the user has any role in ('ALL' for org-wide roles). */
  accessibleBranches(): 'ALL' | string[] {
    if (this.grants.some((g) => g.branchId === null)) return 'ALL';
    return [...new Set(this.grants.map((g) => g.branchId as string))];
  }

  /**
   * Anti-escalation rule: an actor may hand out (to a role or a user) only permissions they
   * themselves hold in that scope. Returns the codes the actor is missing.
   */
  missingForGrant(permissions: readonly string[], branchId: string | null): string[] {
    const eff = this.effective(branchId);
    return permissions.filter((p) => !eff.has(p));
  }
}
