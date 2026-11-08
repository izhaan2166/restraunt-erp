import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser, RequirePermissions } from '../../common/decorators/auth.decorators';
import { requestMeta } from '../../common/http/request-meta';
import type { AuthPrincipal } from '../auth/principal';
import {
  CreateTableDto,
  ListTablesQuery,
  MergeTablesDto,
  OpenTableDto,
  OutOfServiceDto,
  ReserveTableDto,
  SaveLayoutDto,
  TransferTableDto,
  UpdateTableDto,
} from './dto/tables.dto';
import { TablesService } from './tables.service';

@ApiTags('tables')
@ApiBearerAuth()
@Controller('branches/:branchId/tables')
export class TablesController {
  constructor(private readonly tables: TablesService) {}

  @Get()
  @RequirePermissions('tables.read', 'branch')
  list(@CurrentUser() u: AuthPrincipal, @Param('branchId', ParseUUIDPipe) branchId: string, @Query() q: ListTablesQuery) {
    return this.tables.list(u, branchId, q);
  }

  @Get(':id')
  @RequirePermissions('tables.read', 'branch')
  get(@CurrentUser() u: AuthPrincipal, @Param('branchId', ParseUUIDPipe) branchId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.tables.get(u, branchId, id);
  }

  @Post()
  @RequirePermissions('tables.manage', 'branch')
  create(@CurrentUser() u: AuthPrincipal, @Param('branchId', ParseUUIDPipe) branchId: string, @Body() dto: CreateTableDto, @Req() req: Request) {
    return this.tables.create(u, branchId, dto, requestMeta(req));
  }

  /** Bulk save of positions/sizes from the floor-plan editor. */
  @Put('layout')
  @RequirePermissions('tables.manage', 'branch')
  saveLayout(@CurrentUser() u: AuthPrincipal, @Param('branchId', ParseUUIDPipe) branchId: string, @Body() dto: SaveLayoutDto, @Req() req: Request) {
    return this.tables.saveLayout(u, branchId, dto, requestMeta(req));
  }

  @Patch(':id')
  @RequirePermissions('tables.manage', 'branch')
  update(
    @CurrentUser() u: AuthPrincipal,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTableDto,
    @Req() req: Request,
  ) {
    return this.tables.update(u, branchId, id, dto, requestMeta(req));
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('tables.manage', 'branch')
  async remove(@CurrentUser() u: AuthPrincipal, @Param('branchId', ParseUUIDPipe) branchId: string, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    await this.tables.remove(u, branchId, id, requestMeta(req));
  }

  @Post(':id/open')
  @RequirePermissions('tables.operate', 'branch')
  open(
    @CurrentUser() u: AuthPrincipal,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OpenTableDto,
    @Req() req: Request,
  ) {
    return this.tables.open(u, branchId, id, dto, requestMeta(req));
  }

  @Post(':id/close')
  @HttpCode(200)
  @RequirePermissions('tables.operate', 'branch')
  close(@CurrentUser() u: AuthPrincipal, @Param('branchId', ParseUUIDPipe) branchId: string, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.tables.close(u, branchId, id, requestMeta(req));
  }

  @Post(':id/transfer')
  @HttpCode(200)
  @RequirePermissions('tables.operate', 'branch')
  transfer(
    @CurrentUser() u: AuthPrincipal,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransferTableDto,
    @Req() req: Request,
  ) {
    return this.tables.transfer(u, branchId, id, dto, requestMeta(req));
  }

  @Post(':id/merge')
  @HttpCode(200)
  @RequirePermissions('tables.operate', 'branch')
  merge(
    @CurrentUser() u: AuthPrincipal,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MergeTablesDto,
    @Req() req: Request,
  ) {
    return this.tables.merge(u, branchId, id, dto, requestMeta(req));
  }

  @Post(':id/split')
  @HttpCode(200)
  @RequirePermissions('tables.operate', 'branch')
  split(@CurrentUser() u: AuthPrincipal, @Param('branchId', ParseUUIDPipe) branchId: string, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.tables.split(u, branchId, id, requestMeta(req));
  }

  @Post(':id/reserve')
  @HttpCode(200)
  @RequirePermissions('tables.operate', 'branch')
  reserve(
    @CurrentUser() u: AuthPrincipal,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReserveTableDto,
    @Req() req: Request,
  ) {
    return this.tables.reserve(u, branchId, id, dto, requestMeta(req));
  }

  @Delete(':id/reservation')
  @RequirePermissions('tables.operate', 'branch')
  unreserve(@CurrentUser() u: AuthPrincipal, @Param('branchId', ParseUUIDPipe) branchId: string, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.tables.unreserve(u, branchId, id, requestMeta(req));
  }

  @Patch(':id/service-status')
  @RequirePermissions('tables.manage', 'branch')
  setOutOfService(
    @CurrentUser() u: AuthPrincipal,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OutOfServiceDto,
    @Req() req: Request,
  ) {
    return this.tables.setOutOfService(u, branchId, id, dto, requestMeta(req));
  }
}
