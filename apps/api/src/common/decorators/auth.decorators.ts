import { ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';
import type { AuthPrincipal, AuthedRequest } from '../../modules/auth/principal';
import type { PermissionCode } from '../../modules/rbac/permissions.catalog';

export const IS_PUBLIC = 'ros:isPublic';
export const AUTHENTICATED_ONLY = 'ros:authenticatedOnly';
export const REQUIRED_PERMISSIONS = 'ros:requiredPermissions';
export const AUTH_THROTTLE = 'ros:authThrottle';

/** Puts the route in the strict `auth` rate-limit bucket (credential-guessing protection). */
export const AuthThrottle = () => SetMetadata(AUTH_THROTTLE, true);

/**
 * - `auto`   (default) branch-scoped when the request names a branch, otherwise organization-wide.
 * - `branch` the request must name a branch (route param, `branchId` query/body, or `X-Branch-Id`).
 * - `org`    only organization-wide role assignments count.
 * - `any`    held organization-wide or in at least one branch; the service then checks each
 *            resource it touches (used when one request spans several branches).
 */
export type PermissionScope = 'auto' | 'branch' | 'org' | 'any';

export interface PermissionRequirement {
  permissions: PermissionCode[];
  scope: PermissionScope;
}

/** Route needs no authentication (login, refresh, health…). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Any authenticated user may call this route (e.g. GET /auth/me). */
export const AuthenticatedOnly = () => SetMetadata(AUTHENTICATED_ONLY, true);

/** Caller must hold *all* listed permissions in the resolved scope. */
export const RequirePermissions = (permissions: PermissionCode | PermissionCode[], scope: PermissionScope = 'auto') =>
  SetMetadata(REQUIRED_PERMISSIONS, {
    permissions: Array.isArray(permissions) ? permissions : [permissions],
    scope,
  } satisfies PermissionRequirement);

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthPrincipal => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.user) throw new Error('CurrentUser used on a route without authentication');
  return req.user;
});

/** The validated branch id for the request (null for organization-scoped calls). */
export const CurrentBranch = createParamDecorator((_data: unknown, ctx: ExecutionContext): string | null => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().branchId ?? null;
});
