import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser, RequirePermissions } from '../../common/decorators/auth.decorators';
import { requestMeta } from '../../common/http/request-meta';
import type { AuthPrincipal } from '../auth/principal';
import { CreateStationDto, UpdateStationDto } from './dto/station.dto';
import { KitchenStationsService } from './kitchen-stations.service';

@ApiTags('kitchen-stations')
@ApiBearerAuth()
@Controller('branches/:branchId/kitchen-stations')
export class KitchenStationsController {
  constructor(private readonly stations: KitchenStationsService) {}

  @Get()
  @RequirePermissions('menu.read', 'branch')
  list(@CurrentUser() user: AuthPrincipal, @Param('branchId', ParseUUIDPipe) branchId: string) {
    return this.stations.list(user, branchId);
  }

  @Post()
  @RequirePermissions('menu.manage', 'branch')
  create(
    @CurrentUser() user: AuthPrincipal,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: CreateStationDto,
    @Req() req: Request,
  ) {
    return this.stations.create(user, branchId, dto, requestMeta(req));
  }

  @Patch(':id')
  @RequirePermissions('menu.manage', 'branch')
  update(
    @CurrentUser() user: AuthPrincipal,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStationDto,
    @Req() req: Request,
  ) {
    return this.stations.update(user, branchId, id, dto, requestMeta(req));
  }
}
