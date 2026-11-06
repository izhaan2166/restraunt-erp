import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AUTHENTICATED_ONLY, IS_PUBLIC, REQUIRED_PERMISSIONS } from '../decorators/auth.decorators';
import { PermissionSet } from '../../modules/rbac/permission-resolver';
import { PermissionsGuard } from './permissions.guard';

function ctxWith(meta: Record<string, unknown>, req: Record<string, unknown>) {
  const reflector = { getAllAndOverride: (key: string) => meta[key] } as unknown as Reflector;
  const ctx = {
    getType: () => 'http',
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { reflector, ctx };
}

const prisma = { branch: { findFirst: jest.fn().mockResolvedValue({ id: '6f1b8f0e-1a2b-4c3d-8e9f-001122334455' }) } };
const user = (perms: string[], branchId: string | null = null) => ({
  userId: 'u',
  organizationId: 'o',
  permissions: new PermissionSet([{ roleId: 'r', roleKey: 'X', branchId, permissions: perms }]),
});

describe('PermissionsGuard', () => {
  it('lets public routes through', async () => {
    const { reflector, ctx } = ctxWith({ [IS_PUBLIC]: true }, {});
    await expect(new PermissionsGuard(reflector, prisma as never).canActivate(ctx)).resolves.toBe(true);
  });

  it('denies routes that declare no policy (deny by default)', async () => {
    const { reflector, ctx } = ctxWith({}, { user: user(['orders.read']), params: {}, query: {}, headers: {} });
    await expect(new PermissionsGuard(reflector, prisma as never).canActivate(ctx)).rejects.toMatchObject({
      code: 'ROUTE_NOT_AUTHORIZED',
    });
  });

  it('allows @AuthenticatedOnly routes for any signed-in user', async () => {
    const { reflector, ctx } = ctxWith({ [AUTHENTICATED_ONLY]: true }, { user: user([]), params: {}, query: {}, headers: {} });
    await expect(new PermissionsGuard(reflector, prisma as never).canActivate(ctx)).resolves.toBe(true);
  });

  it('checks the permission in the branch named by the request', async () => {
    const branch = '6f1b8f0e-1a2b-4c3d-8e9f-001122334455';
    const meta = { [REQUIRED_PERMISSIONS]: { permissions: ['orders.read'], scope: 'auto' } };
    const ok = ctxWith(meta, { user: user(['orders.read'], branch), params: {}, query: { branchId: branch }, headers: {} });
    await expect(new PermissionsGuard(ok.reflector, prisma as never).canActivate(ok.ctx)).resolves.toBe(true);

    // Same user, no branch named → only org-wide grants count → denied.
    const noBranch = ctxWith(meta, { user: user(['orders.read'], branch), params: {}, query: {}, headers: {} });
    await expect(new PermissionsGuard(noBranch.reflector, prisma as never).canActivate(noBranch.ctx)).rejects.toMatchObject({
      code: 'MISSING_PERMISSION',
    });
  });

  it('requires a branch for branch-scoped routes', async () => {
    const meta = { [REQUIRED_PERMISSIONS]: { permissions: ['orders.read'], scope: 'branch' } };
    const { reflector, ctx } = ctxWith(meta, { user: user(['orders.read']), params: {}, query: {}, headers: {} });
    await expect(new PermissionsGuard(reflector, prisma as never).canActivate(ctx)).rejects.toMatchObject({
      code: 'BRANCH_REQUIRED',
    });
  });
});
