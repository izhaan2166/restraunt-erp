import { Errors } from '../errors/app-error';
import type { AuthPrincipal } from '../../modules/auth/principal';

/**
 * For records reached by their own id (an order, an invoice), the route can't name the branch up
 * front. Call this once the record is loaded: it answers 404 when the caller has no role in that
 * branch at all (so ids from other branches reveal nothing) and 403 when they do but lack a
 * permission.
 */
export function requireInBranch(actor: AuthPrincipal, branchId: string, permissions: string[], entity = 'Record'): void {
  const access = actor.permissions.accessibleBranches();
  if (access !== 'ALL' && !access.includes(branchId)) throw Errors.notFound(entity);
  const missing = permissions.filter((p) => !actor.permissions.has(p, branchId));
  if (missing.length) {
    throw Errors.forbidden('MISSING_PERMISSION', 'You do not have permission to perform this action', { missing, branchId });
  }
}

export function hasInBranch(actor: AuthPrincipal, branchId: string, permission: string): boolean {
  return actor.permissions.has(permission, branchId);
}
