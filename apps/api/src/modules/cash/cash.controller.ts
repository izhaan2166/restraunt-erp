import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthenticatedOnly, CurrentUser, RequirePermissions } from '../../common/decorators/auth.decorators';
import { requestMeta } from '../../common/http/request-meta';
import { Idempotent } from '../../common/idempotency/idempotency';
import type { AuthPrincipal } from '../auth/principal';
import { CashService } from './cash.service';
import { BranchOnlyQuery, CashMovementDto, CloseShiftDto, ListShiftsQuery, OpenShiftDto, ShiftSummaryQuery } from './dto/cash.dto';

const ID = new ParseUUIDPipe();

@ApiTags('cash shifts')
@ApiBearerAuth()
@Controller('cash-sessions')
export class CashController {
  constructor(private readonly cash: CashService) {}

  @Post('open')
  @Idempotent()
  @RequirePermissions('shifts.open', 'branch')
  open(@CurrentUser() u: AuthPrincipal, @Body() dto: OpenShiftDto, @Req() req: Request) {
    return this.cash.open(u, dto, requestMeta(req));
  }

  @Get('current')
  @RequirePermissions('shifts.open', 'branch')
  current(@CurrentUser() u: AuthPrincipal, @Query() q: BranchOnlyQuery) {
    return this.cash.current(u, q.branchId);
  }

  @Get('summary')
  @RequirePermissions('shifts.read', 'branch')
  summary(@CurrentUser() u: AuthPrincipal, @Query() q: ShiftSummaryQuery) {
    return this.cash.summary(u, q);
  }

  @Get()
  @RequirePermissions('shifts.read', 'branch')
  list(@CurrentUser() u: AuthPrincipal, @Query() q: ListShiftsQuery) {
    return this.cash.list(u, q);
  }

  /** Your own shift, or any shift with `shifts.read`. */
  @Get(':id')
  @AuthenticatedOnly()
  get(@CurrentUser() u: AuthPrincipal, @Param('id', ID) id: string) {
    return this.cash.get(u, id);
  }

  /** Your own shift, or any shift with `shifts.read`. */
  @Get(':id/report')
  @AuthenticatedOnly()
  report(@CurrentUser() u: AuthPrincipal, @Param('id', ID) id: string) {
    return this.cash.report(u, id);
  }

  @Post(':id/movements')
  @Idempotent()
  @RequirePermissions('cash.movement', 'any')
  movement(@CurrentUser() u: AuthPrincipal, @Param('id', ID) id: string, @Body() dto: CashMovementDto, @Req() req: Request) {
    return this.cash.movement(u, id, dto, requestMeta(req));
  }

  @Post(':id/close')
  @HttpCode(200)
  @RequirePermissions('shifts.close', 'any')
  close(@CurrentUser() u: AuthPrincipal, @Param('id', ID) id: string, @Body() dto: CloseShiftDto, @Req() req: Request) {
    return this.cash.close(u, id, dto, requestMeta(req));
  }
}
