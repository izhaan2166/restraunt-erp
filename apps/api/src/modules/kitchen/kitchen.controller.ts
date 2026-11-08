import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser, RequirePermissions } from '../../common/decorators/auth.decorators';
import { requestMeta } from '../../common/http/request-meta';
import type { AuthPrincipal } from '../auth/principal';
import { KitchenStatusDto, ListTicketsQuery } from './dto/kitchen.dto';
import { KitchenService } from './kitchen.service';

/**
 * Kitchen display (KDS). Routes reached by id declare scope 'any'; the service checks the right
 * in the ticket's own branch. Marking SERVED is also allowed with orders.update (floor staff).
 */
@ApiTags('kitchen')
@ApiBearerAuth()
@Controller('kot')
export class KitchenController {
  constructor(private readonly kitchen: KitchenService) {}

  @Get()
  @RequirePermissions('kot.read', 'branch')
  list(@CurrentUser() u: AuthPrincipal, @Query() q: ListTicketsQuery) {
    return this.kitchen.list(u, q);
  }

  @Get(':id')
  @RequirePermissions('kot.read', 'any')
  get(@CurrentUser() u: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.kitchen.get(u, id);
  }

  @Patch('items/:id/status')
  @RequirePermissions('kot.read', 'any')
  setItem(@CurrentUser() u: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: KitchenStatusDto, @Req() req: Request) {
    return this.kitchen.setItemStatus(u, id, dto, requestMeta(req));
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermissions('kot.read', 'any')
  setTicket(@CurrentUser() u: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: KitchenStatusDto, @Req() req: Request) {
    return this.kitchen.setTicketStatus(u, id, dto, requestMeta(req));
  }
}
