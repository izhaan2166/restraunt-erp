/**
 * The permission catalog. Codes are stable identifiers stored in the `permissions`
 * table (synced by the seed script) and referenced by @RequirePermissions().
 * Add new codes here; never rename an existing one without a data migration.
 */
export const PERMISSIONS = {
  // Organization & settings
  'organization.read': 'View organization profile and GST details',
  'organization.update': 'Edit organization profile, GSTIN and legal details',
  'branches.read': 'View branches',
  'branches.create': 'Create branches',
  'branches.update': 'Edit branch details',
  'settings.read': 'View branch settings',
  'settings.update': 'Change branch settings (tax mode, rounding, stock policy)',
  // Users & access
  'users.read': 'View user accounts',
  'users.create': 'Create user accounts',
  'users.update': 'Edit user accounts',
  'users.deactivate': 'Deactivate user accounts and revoke their sessions',
  'users.assign_roles': 'Assign or remove roles for users',
  'roles.read': 'View roles and the permission catalog',
  'roles.manage': 'Create custom roles and change role permissions',
  'audit.read': 'View the audit log',
  // Menu & tables
  'menu.read': 'View menu, categories and products',
  'menu.manage': 'Create and edit categories, products, variants and add-ons',
  'menu.price.update': 'Change product and branch prices',
  'tables.read': 'View floor plan and table status',
  'tables.manage': 'Add and edit tables and floor layout',
  'tables.operate': 'Open, transfer, merge and split tables',
  // Orders & kitchen
  'orders.read': 'View orders',
  'orders.create': 'Create orders',
  'orders.update': 'Edit active orders and add/remove items',
  'orders.cancel': 'Cancel orders or items (reason required)',
  'orders.reopen': 'Reopen completed or cancelled orders',
  'kot.submit': 'Send orders to the kitchen',
  'kot.read': 'View kitchen tickets',
  'kot.update_status': 'Mark kitchen items preparing/ready',
  // Billing
  'billing.checkout': 'Run checkout and generate bills',
  'billing.discount.apply': 'Apply discounts within the configured cashier limit',
  'billing.discount.override': 'Apply discounts above the cashier limit',
  'billing.price.override': 'Override an item price on an order',
  'invoices.read': 'View invoices',
  'invoices.create': 'Create invoices',
  'invoices.finalize': 'Finalize invoices',
  'payments.read': 'View payments',
  'payments.create': 'Record payments',
  'refunds.create': 'Initiate refunds',
  'refunds.approve': 'Approve refunds',
  'credit_notes.create': 'Issue credit notes and invoice corrections',
  'taxes.manage': 'Configure tax rates',
  'discounts.manage': 'Configure discount schemes',
  // Inventory & purchasing
  'inventory.read': 'View stock levels and movements',
  'inventory.adjust': 'Record manual stock adjustments',
  'inventory.wastage': 'Record wastage and damaged stock',
  'recipes.manage': 'Configure recipes / bill of materials',
  'suppliers.read': 'View suppliers',
  'suppliers.manage': 'Create and edit suppliers',
  'purchases.read': 'View purchase orders and goods receipts',
  'purchases.create': 'Create purchase orders',
  'purchases.approve': 'Approve purchase orders',
  'purchases.receive': 'Record goods received',
  'supplier_payments.create': 'Record supplier invoices and payments',
  // Finance & people
  'expenses.read': 'View expenses',
  'expenses.create': 'Record expenses',
  'expenses.update': 'Edit expenses',
  'expenses.delete': 'Delete expenses',
  'employees.read': 'View employee profiles',
  'employees.manage': 'Create and edit employee profiles',
  'attendance.manage': 'Record attendance for any employee',
  'attendance.self': 'Clock in and out for yourself',
  'shifts.read': 'View cash shift reports',
  'shifts.open': 'Open a cash shift',
  'shifts.close': 'Close a cash shift with reconciliation',
  'cash.movement': 'Record cash additions and withdrawals',
  // Reporting
  'dashboard.read': 'View the dashboard',
  'reports.sales': 'Sales reports',
  'reports.financial': 'Financial reports (P&L, payments, refunds)',
  'reports.gst': 'GST reports',
  'reports.inventory': 'Inventory, consumption and wastage reports',
  'reports.employee': 'Employee performance and shift reports',
  'notifications.read': 'Receive in-app notifications',
} as const;

export type PermissionCode = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as PermissionCode[];

export function moduleOf(code: string): string {
  return code.split('.')[0];
}

export function isPermissionCode(code: string): code is PermissionCode {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, code);
}
