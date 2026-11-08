import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser, RequirePermissions } from '../../common/decorators/auth.decorators';
import { requestMeta } from '../../common/http/request-meta';
import type { AuthPrincipal } from '../auth/principal';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/menu.dto';

@ApiTags('menu')
@ApiBearerAuth()
@Controller('menu/categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  @RequirePermissions('menu.read', 'any')
  list(@CurrentUser() user: AuthPrincipal) {
    return this.categories.list(user);
  }

  @Get(':id')
  @RequirePermissions('menu.read', 'any')
  get(@CurrentUser() user: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.categories.get(user, id);
  }

  @Post()
  @RequirePermissions('menu.manage', 'org')
  create(@CurrentUser() user: AuthPrincipal, @Body() dto: CreateCategoryDto, @Req() req: Request) {
    return this.categories.create(user, dto, requestMeta(req));
  }

  @Patch(':id')
  @RequirePermissions('menu.manage', 'org')
  update(@CurrentUser() user: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCategoryDto, @Req() req: Request) {
    return this.categories.update(user, id, dto, requestMeta(req));
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('menu.manage', 'org')
  async remove(@CurrentUser() user: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    await this.categories.remove(user, id, requestMeta(req));
  }
}
