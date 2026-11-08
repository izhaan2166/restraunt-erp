import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthenticatedOnly, CurrentUser, RequirePermissions } from '../../common/decorators/auth.decorators';
import { requestMeta } from '../../common/http/request-meta';
import { Idempotent } from '../../common/idempotency/idempotency';
import type { AuthPrincipal } from '../auth/principal';
import {
  AdjustmentDto,
  CreateIngredientDto,
  ListIngredientsQuery,
  MovementsQuery,
  RecipeQuery,
  SetLevelsDto,
  SetRecipeDto,
  StockCountDto,
  StockQuery,
  UpdateIngredientDto,
  WastageDto,
} from './dto/inventory.dto';
import { InventoryService } from './inventory.service';

@ApiTags('inventory')
@ApiBearerAuth()
@Controller()
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('units')
  @AuthenticatedOnly()
  units() {
    return this.inventory.units();
  }

  // Ingredients are organization-wide; stock is per branch.

  @Get('ingredients')
  @RequirePermissions('inventory.read', 'any')
  listIngredients(@CurrentUser() u: AuthPrincipal, @Query() q: ListIngredientsQuery) {
    return this.inventory.listIngredients(u, q);
  }

  @Get('ingredients/:id')
  @RequirePermissions('inventory.read', 'any')
  getIngredient(@CurrentUser() u: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.inventory.getIngredient(u, id);
  }

  @Post('ingredients')
  @RequirePermissions('inventory.manage', 'any')
  createIngredient(@CurrentUser() u: AuthPrincipal, @Body() dto: CreateIngredientDto, @Req() req: Request) {
    return this.inventory.createIngredient(u, dto, requestMeta(req));
  }

  @Patch('ingredients/:id')
  @RequirePermissions('inventory.manage', 'any')
  updateIngredient(@CurrentUser() u: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateIngredientDto, @Req() req: Request) {
    return this.inventory.updateIngredient(u, id, dto, requestMeta(req));
  }

  @Delete('ingredients/:id')
  @HttpCode(204)
  @RequirePermissions('inventory.manage', 'any')
  deleteIngredient(@CurrentUser() u: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.inventory.deleteIngredient(u, id, requestMeta(req));
  }

  @Get('inventory')
  @RequirePermissions('inventory.read', 'branch')
  stock(@CurrentUser() u: AuthPrincipal, @Query() q: StockQuery) {
    return this.inventory.stock(u, q);
  }

  @Get('inventory/low-stock')
  @RequirePermissions('inventory.read', 'branch')
  lowStock(@CurrentUser() u: AuthPrincipal, @Query() q: StockQuery) {
    return this.inventory.stock(u, { ...q, lowOnly: true });
  }

  @Put('inventory/levels')
  @RequirePermissions('inventory.manage', 'branch')
  setLevels(@CurrentUser() u: AuthPrincipal, @Body() dto: SetLevelsDto, @Req() req: Request) {
    return this.inventory.setLevels(u, dto, requestMeta(req));
  }

  @Get('inventory/movements')
  @RequirePermissions('inventory.read', 'branch')
  movements(@CurrentUser() u: AuthPrincipal, @Query() q: MovementsQuery) {
    return this.inventory.movements(u, q);
  }

  @Post('inventory/adjustments')
  @Idempotent()
  @RequirePermissions('inventory.adjust', 'branch')
  adjust(@CurrentUser() u: AuthPrincipal, @Body() dto: AdjustmentDto, @Req() req: Request) {
    return this.inventory.adjust(u, dto, requestMeta(req));
  }

  @Post('inventory/stock-counts')
  @Idempotent()
  @RequirePermissions('inventory.adjust', 'branch')
  count(@CurrentUser() u: AuthPrincipal, @Body() dto: StockCountDto, @Req() req: Request) {
    return this.inventory.count(u, dto, requestMeta(req));
  }

  @Post('inventory/wastage')
  @Idempotent()
  @RequirePermissions('inventory.wastage', 'branch')
  wastage(@CurrentUser() u: AuthPrincipal, @Body() dto: WastageDto, @Req() req: Request) {
    return this.inventory.wastage(u, dto, requestMeta(req));
  }

  @Get('recipes/:productId')
  @RequirePermissions('inventory.read', 'any')
  getRecipe(@CurrentUser() u: AuthPrincipal, @Param('productId', ParseUUIDPipe) productId: string, @Query() q: RecipeQuery) {
    return this.inventory.getRecipe(u, productId, q);
  }

  @Put('recipes/:productId')
  @RequirePermissions('recipes.manage', 'any')
  setRecipe(@CurrentUser() u: AuthPrincipal, @Param('productId', ParseUUIDPipe) productId: string, @Body() dto: SetRecipeDto, @Req() req: Request) {
    return this.inventory.setRecipe(u, productId, dto, requestMeta(req));
  }

  @Delete('recipes/:productId')
  @HttpCode(204)
  @RequirePermissions('recipes.manage', 'any')
  deleteRecipe(@CurrentUser() u: AuthPrincipal, @Param('productId', ParseUUIDPipe) productId: string, @Query() q: RecipeQuery, @Req() req: Request) {
    return this.inventory.deleteRecipe(u, productId, q, requestMeta(req));
  }
}
