import type { Request } from 'express';
import { PermissionSet } from '../rbac/permission-resolver';

/** The authenticated caller, attached to the request by JwtAuthGuard. */
export interface AuthPrincipal {
  userId: string;
  organizationId: string;
  sessionId: string;
  email: string;
  fullName: string;
  permissions: PermissionSet;
}

export type AuthedRequest = Request & {
  id?: string;
  user?: AuthPrincipal;
  /** Branch the request operates on, validated to belong to the caller's organization. */
  branchId?: string | null;
};
