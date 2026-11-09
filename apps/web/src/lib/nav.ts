import { ChefHat, ClipboardList, LayoutGrid, LucideIcon, ShoppingCart } from 'lucide-react';

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
];

export function visibleNav(can: (p: string) => boolean) {
  return NAV.filter((n) => n.anyOf.some((p) => can(p)));
}

/** Where each person lands after signing in: the first screen their role uses. */
export function homeFor(can: (p: string) => boolean): string {
  if (can('kot.read') && !can('orders.create')) return '/kitchen';
  return visibleNav(can)[0]?.href ?? '/no-access';
}
