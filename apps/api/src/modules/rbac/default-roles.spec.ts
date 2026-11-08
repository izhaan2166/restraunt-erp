import { DEFAULT_ROLES, SUPER_ADMIN } from './default-roles';
import { ALL_PERMISSIONS, PermissionCode, isPermissionCode } from './permissions.catalog';

const perms = (key: string) => new Set<string>(DEFAULT_ROLES.find((r) => r.key === key)!.permissions);

describe('default role matrix', () => {
  it('defines the eight roles from the specification', () => {
    expect(DEFAULT_ROLES.map((r) => r.key)).toEqual([
      SUPER_ADMIN,
      'OWNER',
      'MANAGER',
      'CASHIER',
      'WAITER',
      'KITCHEN_STAFF',
      'INVENTORY_MANAGER',
      'ACCOUNTANT',
    ]);
  });

  it('only references permissions that exist, without duplicates', () => {
    for (const role of DEFAULT_ROLES) {
      expect(role.permissions.filter((p) => !isPermissionCode(p))).toEqual([]);
      expect(new Set(role.permissions).size).toBe(role.permissions.length);
    }
  });

  it('gives Super Admin everything', () => {
    expect(perms(SUPER_ADMIN).size).toBe(ALL_PERMISSIONS.length);
  });

  // "Prevent unauthorized discounts, refunds, cancellations and price changes."
  const sensitive: [PermissionCode, string[]][] = [
    ['billing.discount.override', ['SUPER_ADMIN', 'OWNER', 'MANAGER']],
    ['refunds.approve', ['SUPER_ADMIN', 'OWNER', 'MANAGER']],
    ['orders.cancel', ['SUPER_ADMIN', 'OWNER', 'MANAGER']],
    ['orders.reopen', ['SUPER_ADMIN', 'OWNER', 'MANAGER']],
    ['menu.price.update', ['SUPER_ADMIN', 'OWNER']],
    ['billing.price.override', ['SUPER_ADMIN', 'OWNER']],
    ['roles.manage', ['SUPER_ADMIN', 'OWNER']],
    ['credit_notes.create', ['SUPER_ADMIN', 'OWNER', 'ACCOUNTANT', 'MANAGER']],
  ];
  it.each(sensitive)('%s is held only by %j', (code, holders) => {
    const actual = DEFAULT_ROLES.filter((r) => r.permissions.includes(code)).map((r) => r.key);
    expect(actual.sort()).toEqual([...holders].sort());
  });

  it('keeps each front-of-house role to its job', () => {
    const waiter = perms('WAITER');
    expect(waiter.has('kot.submit')).toBe(true);
    expect(waiter.has('payments.create')).toBe(false);
    expect(waiter.has('billing.discount.apply')).toBe(false);

    const kitchen = perms('KITCHEN_STAFF');
    expect(kitchen.has('kot.update_status')).toBe(true);
    expect(kitchen.has('orders.create')).toBe(false);

    const cashier = perms('CASHIER');
    expect(cashier.has('payments.create')).toBe(true);
    expect(cashier.has('refunds.create')).toBe(true);
    expect(cashier.has('refunds.approve')).toBe(false);
    expect(cashier.has('reports.financial')).toBe(false);

    const accountant = perms('ACCOUNTANT');
    expect(accountant.has('reports.gst')).toBe(true);
    expect(accountant.has('orders.create')).toBe(false);

    const inventory = perms('INVENTORY_MANAGER');
    expect(inventory.has('purchases.receive')).toBe(true);
    expect(inventory.has('payments.create')).toBe(false);
  });

  it('lets a manager hire every branch-level role without privilege escalation', () => {
    const manager = perms('MANAGER');
    for (const key of ['CASHIER', 'WAITER', 'KITCHEN_STAFF', 'INVENTORY_MANAGER']) {
      expect([...perms(key)].filter((p) => !manager.has(p))).toEqual([]);
    }
  });
});
