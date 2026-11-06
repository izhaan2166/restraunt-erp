import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentBranch, CurrentUser, RequirePermissions } from '../../common/decorators/auth.decorators';
import { requestMeta } from '../../common/http/request-meta';
import type { AuthPrincipal } from '../auth/principal';
import { CreateUserDto, ListUsersQuery, RoleAssignmentDto, UpdateUserDto } from './dto/user.dto';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermissions('users.read')
  @ApiOperation({ summary: 'List users (organization-wide, or one branch with ?branchId=)' })
  list(@CurrentUser() user: AuthPrincipal, @CurrentBranch() branchId: string | null, @Query() q: ListUsersQuery) {
    return this.users.list(user, branchId, q);
  }

  @Get(':id')
  @RequirePermissions('users.read', 'any')
  get(@CurrentUser() user: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.get(user, id);
  }

  @Post()
  @RequirePermissions(['users.create', 'users.assign_roles'], 'any')
  @ApiOperation({ summary: 'Create a user with one or more role assignments' })
  create(@CurrentUser() user: AuthPrincipal, @Body() dto: CreateUserDto, @Req() req: Request) {
    return this.users.create(user, dto, requestMeta(req));
  }

  @Patch(':id')
  @RequirePermissions('users.update', 'any')
  @ApiOperation({ summary: 'Edit a user; isActive=false deactivates and signs them out everywhere' })
  update(
    @CurrentUser() user: AuthPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
    @Req() req: Request,
  ) {
    return this.users.update(user, id, dto, requestMeta(req));
  }

  @Post(':id/roles')
  @RequirePermissions('users.assign_roles', 'any')
  addRole(
    @CurrentUser() user: AuthPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RoleAssignmentDto,
    @Req() req: Request,
  ) {
    return this.users.addRole(user, id, dto, requestMeta(req));
  }

  @Delete(':id/roles/:assignmentId')
  @RequirePermissions('users.assign_roles', 'any')
  removeRole(
    @CurrentUser() user: AuthPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Req() req: Request,
  ) {
    return this.users.removeRole(user, id, assignmentId, requestMeta(req));
  }
}
