import { ChefHat, ClipboardList, LayoutGrid, LucideIcon, Package, Settings, ShoppingCart } from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shown when the user holds any of these in the selected branch. */
  anyOf: string[];
}

/** Screens in the order staff use them. Each appears only for roles that can use it. */
export const NAV: NavItem[] = [
  { href: '/pos', label: 'POS', icon: ShoppingCart, anyOf: ['orders.create'] },
  { href: '/tables', label: 'Tables', icon: LayoutGrid, anyOf: ['tables.read'] },
  { href: '/orders', label: 'Orders', icon: ClipboardList, anyOf: ['orders.read'] },
  { href: '/kitchen', label: 'Kitchen', icon: ChefHat, anyOf: ['kot.read'] },
  { href: '/stock', label: 'Stock', icon: Package, anyOf: ['inventory.read', 'purchases.read', 'suppliers.read'] },
  { href: '/manage', label: 'Manage', icon: Settings, anyOf: ['menu.manage', 'menu.availability.update', 'users.read', 'branches.update', 'settings.read', 'tables.manage'] },
];

/** Sections of the Manage area, each behind the rights it needs. */
export const MANAGE_NAV: NavItem[] = [
  { href: '/manage/menu', label: 'Menu', icon: ClipboardList, anyOf: ['menu.manage', 'menu.availability.update'] },
  { href: '/manage/staff', label: 'Staff', icon: ClipboardList, anyOf: ['users.read'] },
  { href: '/manage/tables', label: 'Table layout', icon: LayoutGrid, anyOf: ['tables.manage'] },
  { href: '/manage/branches', label: 'Branches', icon: ClipboardList, anyOf: ['branches.update', 'settings.read', 'branches.create'] },
];

/** Sections of the Stock area. */
export const STOCK_NAV: NavItem[] = [
  { href: '/stock/levels', label: 'Stock', icon: Package, anyOf: ['inventory.read'] },
  { href: '/stock/recipes', label: 'Recipes', icon: ClipboardList, anyOf: ['inventory.read'] },
  { href: '/stock/purchases', label: 'Purchase orders', icon: ClipboardList, anyOf: ['purchases.read'] },
  { href: '/stock/suppliers', label: 'Suppliers', icon: ClipboardList, anyOf: ['suppliers.read'] },
];

export function visibleNav(can: (p: string) => boolean) {
  return NAV.filter((n) => n.anyOf.some((p) => can(p)));
}

/** Where each person lands after signing in: the first screen their role uses. */
export function homeFor(can: (p: string) => boolean): string {
  if (can('kot.read') && !can('orders.create')) return '/kitchen';
  return visibleNav(can)[0]?.href ?? '/no-access';
}
