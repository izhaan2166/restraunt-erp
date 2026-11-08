import { Body, Controller, Delete, Get, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser, RequirePermissions } from '../../common/decorators/auth.decorators';
import { requestMeta } from '../../common/http/request-meta';
import { Idempotent } from '../../common/idempotency/idempotency';
import type { AuthPrincipal } from '../auth/principal';
import { ApplyDiscountDto, ChangeStatusDto, CreateOrderDto, ListOrdersQuery, ReasonDto, UpdateOrderDto, VersionDto } from './dto/orders.dto';
import { OrdersService } from './orders.service';

/**
 * Routes reached by order id declare scope 'any'; the service then checks the permission in the
 * order's own branch (404 for branches the caller has no role in).
 */
@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @RequirePermissions('orders.read', 'branch')
  list(@CurrentUser() u: AuthPrincipal, @Query() q: ListOrdersQuery) {
    return this.orders.list(u, q);
  }

  @Post()
  @Idempotent()
  @RequirePermissions('orders.create', 'branch')
  create(@CurrentUser() u: AuthPrincipal, @Body() dto: CreateOrderDto, @Req() req: Request) {
    return this.orders.create(u, dto, requestMeta(req));
  }

  @Get(':id')
  @RequirePermissions('orders.read', 'any')
  get(@CurrentUser() u: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.get(u, id);
  }

  @Patch(':id')
  @RequirePermissions('orders.update', 'any')
  update(@CurrentUser() u: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateOrderDto, @Req() req: Request) {
    return this.orders.update(u, id, dto, requestMeta(req));
  }

  @Post(':id/confirm')
  @RequirePermissions('kot.submit', 'any')
  confirm(@CurrentUser() u: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VersionDto, @Req() req: Request) {
    return this.orders.confirm(u, id, dto, requestMeta(req));
  }

  @Post(':id/kot')
  @RequirePermissions('kot.submit', 'any')
  sendToKitchen(@CurrentUser() u: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VersionDto, @Req() req: Request) {
    return this.orders.sendToKitchen(u, id, dto, requestMeta(req));
  }

  @Post(':id/status')
  @RequirePermissions('orders.update', 'any')
  changeStatus(@CurrentUser() u: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ChangeStatusDto, @Req() req: Request) {
    return this.orders.changeStatus(u, id, dto, requestMeta(req));
  }

  @Post(':id/cancel')
  @RequirePermissions('orders.cancel', 'any')
  cancel(@CurrentUser() u: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @Req() req: Request) {
    return this.orders.cancel(u, id, dto, requestMeta(req));
  }

  @Post(':id/reopen')
  @RequirePermissions('orders.reopen', 'any')
  reopen(@CurrentUser() u: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @Req() req: Request) {
    return this.orders.reopen(u, id, dto, requestMeta(req));
  }

  @Post(':id/discounts')
  @RequirePermissions('billing.discount.apply', 'any')
  applyDiscount(@CurrentUser() u: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ApplyDiscountDto, @Req() req: Request) {
    return this.orders.applyDiscount(u, id, dto, requestMeta(req));
  }

  @Delete(':id/discounts/:discountId')
  @RequirePermissions('billing.discount.apply', 'any')
  removeDiscount(
    @CurrentUser() u: AuthPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('discountId', ParseUUIDPipe) discountId: string,
    @Query('version', ParseIntPipe) version: number,
    @Req() req: Request,
  ) {
    return this.orders.removeDiscount(u, id, discountId, version, requestMeta(req));
  }
}
