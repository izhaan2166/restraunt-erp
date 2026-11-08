import { Errors } from '../../common/errors/app-error';
import type { AuthPrincipal } from '../auth/principal';

/** Menu prices are organization-wide, so changing one needs `menu.price.update` organization-wide. */
export function requirePriceRight(actor: AuthPrincipal, branchId: string | null = null): void {
  if (!actor.permissions.has('menu.price.update', branchId)) {
    throw Errors.forbidden('MISSING_PERMISSION', 'Changing prices requires the menu.price.update permission', {
      missing: ['menu.price.update'],
      branchId,
    });
  }
}
