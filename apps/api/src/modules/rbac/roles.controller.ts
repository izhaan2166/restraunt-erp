import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser, RequirePermissions } from '../../common/decorators/auth.decorators';
import { requestMeta } from '../../common/http/request-meta';
import type { AuthPrincipal } from '../auth/principal';
import { CreateRoleDto, UpdateRolePermissionsDto } from './dto/role.dto';
import { RolesService } from './roles.service';

@ApiTags('roles')
@ApiBearerAuth()
@Controller()
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get('permissions')
  @RequirePermissions('roles.read', 'org')
  @ApiOperation({ summary: 'The permission catalog' })
  permissions() {
    return this.roles.listPermissions();
  }

  @Get('roles')
  @RequirePermissions('roles.read', 'org')
  @ApiOperation({ summary: 'Roles of the organization with their permissions' })
  list(@CurrentUser() user: AuthPrincipal) {
    return this.roles.list(user.organizationId);
  }

  @Get('roles/:id')
  @RequirePermissions('roles.read', 'org')
  get(@CurrentUser() user: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.roles.get(user.organizationId, id);
  }

  @Post('roles')
  @RequirePermissions('roles.manage', 'org')
  @ApiOperation({ summary: 'Create a custom role' })
  create(@CurrentUser() user: AuthPrincipal, @Body() dto: CreateRoleDto, @Req() req: Request) {
    return this.roles.create(user, dto, requestMeta(req));
  }

  @Put('roles/:id/permissions')
  @RequirePermissions('roles.manage', 'org')
  @ApiOperation({ summary: "Replace a role's permissions (not allowed for SUPER_ADMIN)" })
  replace(
    @CurrentUser() user: AuthPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRolePermissionsDto,
    @Req() req: Request,
  ) {
    return this.roles.replacePermissions(user, id, dto, requestMeta(req));
  }

  @Delete('roles/:id')
  @RequirePermissions('roles.manage', 'org')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() user: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.roles.remove(user, id, requestMeta(req));
  }
}
