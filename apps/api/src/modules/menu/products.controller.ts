import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser, RequirePermissions } from '../../common/decorators/auth.decorators';
import { requestMeta } from '../../common/http/request-meta';
import type { AuthPrincipal } from '../auth/principal';
import {
  CreateProductDto,
  ListProductsQuery,
  MenuQuery,
  SetAvailabilityDto,
  SetBranchPricesDto,
  SetComboItemsDto,
  SetModifierGroupsDto,
  UpdateProductDto,
  UpdateVariantDto,
  VariantInputDto,
} from './dto/menu.dto';
import { ProductsService, type UploadedImage } from './products.service';

@ApiTags('menu')
@ApiBearerAuth()
@Controller('menu/products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @RequirePermissions('menu.read', 'any')
  list(@CurrentUser() user: AuthPrincipal, @Query() q: ListProductsQuery) {
    return this.products.list(user, q);
  }

  @Get(':id')
  @RequirePermissions('menu.read', 'any')
  get(@CurrentUser() user: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.products.get(user, id);
  }

  /** Price changes on create/update additionally require `menu.price.update` (checked in the service). */
  @Post()
  @RequirePermissions(['menu.manage', 'menu.price.update'], 'org')
  create(@CurrentUser() user: AuthPrincipal, @Body() dto: CreateProductDto, @Req() req: Request) {
    return this.products.create(user, dto, requestMeta(req));
  }

  @Patch(':id')
  @RequirePermissions('menu.manage', 'org')
  update(@CurrentUser() user: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProductDto, @Req() req: Request) {
    return this.products.update(user, id, dto, requestMeta(req));
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('menu.manage', 'org')
  async remove(@CurrentUser() user: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    await this.products.remove(user, id, requestMeta(req));
  }

  @Post(':id/variants')
  @RequirePermissions('menu.manage', 'org')
  addVariant(@CurrentUser() user: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VariantInputDto, @Req() req: Request) {
    return this.products.addVariant(user, id, dto, requestMeta(req));
  }

  @Patch(':id/variants/:variantId')
  @RequirePermissions('menu.manage', 'org')
  updateVariant(
    @CurrentUser() user: AuthPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: UpdateVariantDto,
    @Req() req: Request,
  ) {
    return this.products.updateVariant(user, id, variantId, dto, requestMeta(req));
  }

  @Put(':id/modifier-groups')
  @RequirePermissions('menu.manage', 'org')
  setModifierGroups(@CurrentUser() user: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetModifierGroupsDto, @Req() req: Request) {
    return this.products.setModifierGroups(user, id, dto.groupIds, requestMeta(req));
  }

  @Put(':id/combo-items')
  @RequirePermissions('menu.manage', 'org')
  setComboItems(@CurrentUser() user: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetComboItemsDto, @Req() req: Request) {
    return this.products.setComboItems(user, id, dto.items, requestMeta(req));
  }

  @Get(':id/branch-prices')
  @RequirePermissions('menu.read', 'branch')
  branchPrices(@CurrentUser() user: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string, @Query() q: MenuQuery) {
    return this.products.branchPrices(user, id, q.branchId);
  }

  /** Branch overrides. Price edits also need `menu.price.update` in that branch (checked in the service). */
  @Put(':id/branch-prices')
  @RequirePermissions('menu.availability.update', 'branch')
  setBranchPrices(@CurrentUser() user: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetBranchPricesDto, @Req() req: Request) {
    return this.products.setBranchPrices(user, id, dto, requestMeta(req));
  }

  /** With `branchId`: that branch only (branch permission). Without: every branch (organization-wide permission). */
  @Patch(':id/availability')
  @RequirePermissions('menu.availability.update', 'auto')
  setAvailability(@CurrentUser() user: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetAvailabilityDto, @Req() req: Request) {
    return this.products.setAvailability(user, id, dto, requestMeta(req));
  }

  @Post(':id/image')
  @RequirePermissions('menu.manage', 'org')
  @UseInterceptors(FileInterceptor('image'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { image: { type: 'string', format: 'binary' } }, required: ['image'] } })
  uploadImage(
    @CurrentUser() user: AuthPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: UploadedImage | undefined,
    @Req() req: Request,
  ) {
    return this.products.uploadImage(user, id, file, requestMeta(req));
  }
}
