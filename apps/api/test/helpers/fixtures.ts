import { randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import { PrismaService } from '../../src/prisma/prisma.service';
import { provisionDefaultRoles } from '../../src/modules/rbac/catalog-sync';
import { API, TestContext } from './app';

export const PASSWORD = 'Str0ngPass!2026';
let cachedHash: Promise<string> | undefined;
const passwordHash = () =>
  (cachedHash ??= argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }));

export type RoleKey =
  | 'SUPER_ADMIN'
  | 'OWNER'
  | 'MANAGER'
  | 'CASHIER'
  | 'WAITER'
  | 'KITCHEN_STAFF'
  | 'INVENTORY_MANAGER'
  | 'ACCOUNTANT';

export interface OrgFixture {
  orgId: string;
  branchA: string;
  branchB: string;
  roles: Map<string, string>;
  /** handle → { id, email } */
  users: Record<string, { id: string; email: string }>;
}

/**
 * A realistic organization: two branches in different states and one user per role.
 * Branch-level staff are assigned to branch A; `managerB` manages branch B.
 */
export async function createOrg(prisma: PrismaService, label = 'Org'): Promise<OrgFixture> {
  const tag = randomUUID().slice(0, 8);
  const org = await prisma.organization.create({
    data: { name: `${label} ${tag}`, legalName: `${label} ${tag} Pvt Ltd`, stateCode: '29' },
  });
  const branchA = await prisma.branch.create({
    data: { organizationId: org.id, code: `A-${tag}`.toUpperCase(), name: `${label} Koramangala`, stateCode: '29' },
  });
  const branchB = await prisma.branch.create({
    data: { organizationId: org.id, code: `B-${tag}`.toUpperCase(), name: `${label} Pune`, stateCode: '27' },
  });
  const roles = await provisionDefaultRoles(prisma, org.id);
  const hash = await passwordHash();
  const spec: [string, RoleKey, string | null][] = [
    ['superAdmin', 'SUPER_ADMIN', null],
    ['owner', 'OWNER', null],
    ['accountant', 'ACCOUNTANT', null],
    ['managerA', 'MANAGER', branchA.id],
    ['managerB', 'MANAGER', branchB.id],
    ['cashierA', 'CASHIER', branchA.id],
    ['cashierB', 'CASHIER', branchB.id],
    ['waiterA', 'WAITER', branchA.id],
    ['kitchenA', 'KITCHEN_STAFF', branchA.id],
    ['inventoryA', 'INVENTORY_MANAGER', branchA.id],
  ];
  const users: OrgFixture['users'] = {};
  for (const [handle, roleKey, branchId] of spec) {
    const email = `${handle.toLowerCase()}.${tag}@test.restaurantos.local`;
    const u = await prisma.user.create({
      data: { organizationId: org.id, email, fullName: `${handle} ${tag}`, passwordHash: hash },
    });
    await prisma.userRole.create({
      data: { organizationId: org.id, userId: u.id, roleId: roles.get(roleKey)!, branchId },
    });
    users[handle] = { id: u.id, email };
  }
  return { orgId: org.id, branchA: branchA.id, branchB: branchB.id, roles, users };
}

export async function login(ctx: TestContext, email: string, password = PASSWORD) {
  const res = await ctx.http().post(`${API}/auth/login`).send({ email, password }).expect(200);
  return res.body.data as { accessToken: string; refreshToken: string; expiresIn: number };
}

export async function tokenFor(ctx: TestContext, fx: OrgFixture, handle: string): Promise<string> {
  return (await login(ctx, fx.users[handle].email)).accessToken;
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Adds a user holding one role (org-wide when branchId is null) and returns their access token. */
export async function addUserWithRole(
  ctx: TestContext,
  fx: OrgFixture,
  handle: string,
  roleId: string,
  branchId: string | null = null,
): Promise<string> {
  const email = `${handle.toLowerCase()}.${randomUUID().slice(0, 8)}@test.restaurantos.local`;
  const u = await ctx.prisma.user.create({
    data: { organizationId: fx.orgId, email, fullName: handle, passwordHash: await passwordHash() },
  });
  await ctx.prisma.userRole.create({ data: { organizationId: fx.orgId, userId: u.id, roleId, branchId } });
  fx.users[handle] = { id: u.id, email };
  return tokenFor(ctx, fx, handle);
}
