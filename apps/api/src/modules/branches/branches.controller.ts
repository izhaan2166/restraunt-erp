import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthenticatedOnly, CurrentUser, RequirePermissions } from '../../common/decorators/auth.decorators';
import { requestMeta } from '../../common/http/request-meta';
import type { AuthPrincipal } from '../auth/principal';
import { BranchesService } from './branches.service';
import { CreateBranchDto, UpdateBranchDto, UpdateBranchSettingsDto } from './dto/branch.dto';

@ApiTags('branches')
@ApiBearerAuth()
@Controller('branches')
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  @Get()
  @AuthenticatedOnly()
  @ApiOperation({ summary: 'Branches the current user can access' })
  list(@CurrentUser() user: AuthPrincipal) {
    return this.branches.list(user);
  }

  @Get(':branchId')
  @RequirePermissions('branches.read', 'branch')
  get(@CurrentUser() user: AuthPrincipal, @Param('branchId', ParseUUIDPipe) branchId: string) {
    return this.branches.get(user, branchId);
  }

  @Post()
  @RequirePermissions('branches.create', 'org')
  @ApiOperation({ summary: 'Create a branch (also creates its default settings)' })
  create(@CurrentUser() user: AuthPrincipal, @Body() dto: CreateBranchDto, @Req() req: Request) {
    return this.branches.create(user, dto, requestMeta(req));
  }

  @Patch(':branchId')
  @RequirePermissions('branches.update', 'branch')
  update(
    @CurrentUser() user: AuthPrincipal,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: UpdateBranchDto,
    @Req() req: Request,
  ) {
    return this.branches.update(user, branchId, dto, requestMeta(req));
  }

  @Get(':branchId/settings')
  @RequirePermissions('settings.read', 'branch')
  settings(@CurrentUser() user: AuthPrincipal, @Param('branchId', ParseUUIDPipe) branchId: string) {
    return this.branches.settings(user, branchId);
  }

  @Patch(':branchId/settings')
  @RequirePermissions('settings.update', 'branch')
  @ApiOperation({ summary: 'Change tax mode, rounding, document prefix, stock deduction and negative-stock rules' })
  updateSettings(
    @CurrentUser() user: AuthPrincipal,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: UpdateBranchSettingsDto,
    @Req() req: Request,
  ) {
    return this.branches.updateSettings(user, branchId, dto, requestMeta(req));
  }
}
