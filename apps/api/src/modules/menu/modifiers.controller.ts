import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser, RequirePermissions } from '../../common/decorators/auth.decorators';
import { requestMeta } from '../../common/http/request-meta';
import type { AuthPrincipal } from '../auth/principal';
import { CreateModifierGroupDto, ModifierInputDto, UpdateModifierDto, UpdateModifierGroupDto } from './dto/menu.dto';
import { ModifiersService } from './modifiers.service';

/** Add-on groups ("Extra toppings", min/max selection) and their add-ons. */
@ApiTags('menu')
@ApiBearerAuth()
@Controller('menu/modifier-groups')
export class ModifiersController {
  constructor(private readonly modifiers: ModifiersService) {}

  @Get()
  @RequirePermissions('menu.read', 'any')
  list(@CurrentUser() user: AuthPrincipal) {
    return this.modifiers.list(user);
  }

  @Get(':id')
  @RequirePermissions('menu.read', 'any')
  get(@CurrentUser() user: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.modifiers.getGroup(user, id);
  }

  @Post()
  @RequirePermissions('menu.manage', 'org')
  create(@CurrentUser() user: AuthPrincipal, @Body() dto: CreateModifierGroupDto, @Req() req: Request) {
    return this.modifiers.createGroup(user, dto, requestMeta(req));
  }

  @Patch(':id')
  @RequirePermissions('menu.manage', 'org')
  update(@CurrentUser() user: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateModifierGroupDto, @Req() req: Request) {
    return this.modifiers.updateGroup(user, id, dto, requestMeta(req));
  }

  @Post(':id/modifiers')
  @RequirePermissions('menu.manage', 'org')
  addModifier(@CurrentUser() user: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ModifierInputDto, @Req() req: Request) {
    return this.modifiers.addModifier(user, id, dto, requestMeta(req));
  }

  @Patch(':id/modifiers/:modifierId')
  @RequirePermissions('menu.manage', 'org')
  updateModifier(
    @CurrentUser() user: AuthPrincipal,
    @Param('modifierId', ParseUUIDPipe) modifierId: string,
    @Body() dto: UpdateModifierDto,
    @Req() req: Request,
  ) {
    return this.modifiers.updateModifier(user, modifierId, dto, requestMeta(req));
  }
}
