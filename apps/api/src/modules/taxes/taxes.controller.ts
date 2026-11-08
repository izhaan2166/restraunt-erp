import { Body, Controller, Get, Param, ParseBoolPipe, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser, RequirePermissions } from '../../common/decorators/auth.decorators';
import { requestMeta } from '../../common/http/request-meta';
import type { AuthPrincipal } from '../auth/principal';
import { CreateTaxRateDto, UpdateTaxRateDto } from './dto/tax-rate.dto';
import { TaxesService } from './taxes.service';

@ApiTags('taxes')
@ApiBearerAuth()
@Controller('tax-rates')
export class TaxesController {
  constructor(private readonly taxes: TaxesService) {}

  @Get()
  @RequirePermissions('menu.read', 'any')
  @ApiQuery({ name: 'includeInactive', required: false, type: Boolean })
  list(@CurrentUser() user: AuthPrincipal, @Query('includeInactive', new ParseBoolPipe({ optional: true })) inactive?: boolean) {
    return this.taxes.list(user, inactive ?? false);
  }

  @Post()
  @RequirePermissions('taxes.manage', 'org')
  @ApiOperation({ summary: 'Create a GST rate (CGST/SGST/IGST are derived from the total rate)' })
  create(@CurrentUser() user: AuthPrincipal, @Body() dto: CreateTaxRateDto, @Req() req: Request) {
    return this.taxes.create(user, dto, requestMeta(req));
  }

  @Patch(':id')
  @RequirePermissions('taxes.manage', 'org')
  @ApiOperation({ summary: 'Rename, deactivate or end-date a rate. Percentages are immutable.' })
  update(@CurrentUser() user: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTaxRateDto, @Req() req: Request) {
    return this.taxes.update(user, id, dto, requestMeta(req));
  }
}
