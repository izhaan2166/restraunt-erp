import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions } from '../../common/decorators/auth.decorators';
import type { AuthPrincipal } from '../auth/principal';
import { MenuQuery } from './dto/menu.dto';
import { MenuService } from './menu.service';

@ApiTags('menu')
@ApiBearerAuth()
@Controller('menu')
export class MenuController {
  constructor(private readonly menu: MenuService) {}

  /** POS menu for one branch with branch prices and availability resolved. */
  @Get()
  @RequirePermissions('menu.read', 'branch')
  forBranch(@CurrentUser() user: AuthPrincipal, @Query() q: MenuQuery) {
    return this.menu.forBranch(user, q.branchId);
  }
}
