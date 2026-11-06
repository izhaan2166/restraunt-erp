import { PermissionSet, RoleGrant } from './permission-resolver';
import { ALL_PERMISSIONS } from './permissions.catalog';

const grant = (roleKey: string, branchId: string | null, permissions: string[]): RoleGrant => ({
  roleId: `${roleKey}-${branchId ?? 'org'}`,
  roleKey,
  branchId,
  permissions,
});

describe('PermissionSet', () => {
  const A = 'branch-a';
  const B = 'branch-b';

  it('applies branch grants only in that branch', () => {
    const set = new PermissionSet([grant('CASHIER', A, ['payments.create'])]);
    expect(set.has('payments.create', A)).toBe(true);
    expect(set.has('payments.create', B)).toBe(false);
    expect(set.has('payments.create', null)).toBe(false);
  });

  it('applies organization-wide grants everywhere', () => {
    const set = new PermissionSet([grant('ACCOUNTANT', null, ['reports.gst'])]);
    expect(set.has('reports.gst', null)).toBe(true);
    expect(set.has('reports.gst', A)).toBe(true);
    expect(set.branchesWith('reports.gst')).toBe('ALL');
  });

  it('unions multiple roles', () => {
    const set = new PermissionSet([grant('WAITER', A, ['orders.create']), grant('CASHIER', A, ['payments.create'])]);
    expect(set.hasAll(['orders.create', 'payments.create'], A)).toBe(true);
    expect(set.hasAll(['orders.create', 'refunds.approve'], A)).toBe(false);
  });

  it('gives Super Admin every permission, including ones not stored on the role', () => {
    const set = new PermissionSet([grant('SUPER_ADMIN', null, [])]);
    expect(set.isSuperAdmin()).toBe(true);
    expect(set.effective(A).size).toBe(ALL_PERMISSIONS.length);
    expect(set.missingForGrant(ALL_PERMISSIONS, null)).toEqual([]);
  });

  it('does not treat a branch-scoped SUPER_ADMIN assignment as platform-wide', () => {
    const set = new PermissionSet([grant('SUPER_ADMIN', A, [])]);
    expect(set.isSuperAdmin()).toBe(false);
  });

  it('lists the branches where a permission is held', () => {
    const set = new PermissionSet([grant('MANAGER', A, ['users.read']), grant('MANAGER', B, ['users.read']), grant('WAITER', 'c', [])]);
    expect(set.branchesWith('users.read')).toEqual([A, B]);
    expect(set.branchesWith('reports.gst')).toEqual([]);
    expect(set.accessibleBranches()).toEqual([A, B, 'c']);
  });

  it('reports what an actor is missing before granting (anti-escalation)', () => {
    const set = new PermissionSet([grant('MANAGER', A, ['orders.read', 'orders.cancel'])]);
    expect(set.missingForGrant(['orders.read', 'refunds.approve'], A)).toEqual(['refunds.approve']);
    expect(set.missingForGrant(['orders.read'], B)).toEqual(['orders.read']);
  });
});
