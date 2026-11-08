import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CurrentUser, RequirePermissions } from '../../common/decorators/auth.decorators';
import { requestMeta } from '../../common/http/request-meta';
import { Idempotent } from '../../common/idempotency/idempotency';
import type { AuthPrincipal } from '../auth/principal';
import {
  CreateExpenseDto,
  DeleteExpenseDto,
  ExpenseCategoryDto,
  ExpenseSummaryQuery,
  ListExpenseCategoriesQuery,
  ListExpensesQuery,
  UpdateExpenseCategoryDto,
  UpdateExpenseDto,
} from './dto/expenses.dto';
import { ExpensesService, UploadedReceipt } from './expenses.service';

const ID = new ParseUUIDPipe();

@ApiTags('expenses')
@ApiBearerAuth()
@Controller()
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get('expense-categories')
  @RequirePermissions('expenses.read', 'any')
  listCategories(@CurrentUser() u: AuthPrincipal, @Query() q: ListExpenseCategoriesQuery) {
    return this.expenses.listCategories(u, q);
  }

  @Post('expense-categories')
  @RequirePermissions('expenses.create', 'any')
  createCategory(@CurrentUser() u: AuthPrincipal, @Body() dto: ExpenseCategoryDto, @Req() req: Request) {
    return this.expenses.createCategory(u, dto, requestMeta(req));
  }

  @Patch('expense-categories/:id')
  @RequirePermissions('expenses.update', 'any')
  updateCategory(@CurrentUser() u: AuthPrincipal, @Param('id', ID) id: string, @Body() dto: UpdateExpenseCategoryDto, @Req() req: Request) {
    return this.expenses.updateCategory(u, id, dto, requestMeta(req));
  }

  @Get('expenses/summary')
  @RequirePermissions('expenses.read', 'branch')
  summary(@CurrentUser() u: AuthPrincipal, @Query() q: ExpenseSummaryQuery) {
    return this.expenses.summary(u, q);
  }

  @Get('expenses')
  @RequirePermissions('expenses.read', 'branch')
  list(@CurrentUser() u: AuthPrincipal, @Query() q: ListExpensesQuery) {
    return this.expenses.list(u, q);
  }

  @Get('expenses/:id')
  @RequirePermissions('expenses.read', 'any')
  get(@CurrentUser() u: AuthPrincipal, @Param('id', ID) id: string) {
    return this.expenses.get(u, id);
  }

  @Get('expenses/:id/history')
  @RequirePermissions('expenses.read', 'any')
  history(@CurrentUser() u: AuthPrincipal, @Param('id', ID) id: string) {
    return this.expenses.history(u, id);
  }

  @Post('expenses')
  @Idempotent()
  @RequirePermissions('expenses.create', 'branch')
  create(@CurrentUser() u: AuthPrincipal, @Body() dto: CreateExpenseDto, @Req() req: Request) {
    return this.expenses.create(u, dto, requestMeta(req));
  }

  @Patch('expenses/:id')
  @RequirePermissions('expenses.update', 'any')
  update(@CurrentUser() u: AuthPrincipal, @Param('id', ID) id: string, @Body() dto: UpdateExpenseDto, @Req() req: Request) {
    return this.expenses.update(u, id, dto, requestMeta(req));
  }

  @Delete('expenses/:id')
  @HttpCode(204)
  @RequirePermissions('expenses.delete', 'any')
  remove(@CurrentUser() u: AuthPrincipal, @Param('id', ID) id: string, @Body() dto: DeleteExpenseDto, @Req() req: Request) {
    return this.expenses.remove(u, id, dto.reason, requestMeta(req));
  }

  /** The person who recorded the expense, or anyone with `expenses.update`. */
  @Post('expenses/:id/receipt')
  @RequirePermissions('expenses.create', 'any')
  @UseInterceptors(FileInterceptor('receipt'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { receipt: { type: 'string', format: 'binary' } }, required: ['receipt'] } })
  uploadReceipt(@CurrentUser() u: AuthPrincipal, @Param('id', ID) id: string, @UploadedFile() file: UploadedReceipt | undefined, @Req() req: Request) {
    return this.expenses.uploadReceipt(u, id, file, requestMeta(req));
  }

  /**
   * The receipt file. Local storage streams it; S3 redirects to a signed URL that expires in
   * minutes. Either way it is never cached by browsers or proxies.
   */
  @Get('expenses/:id/receipt')
  @RequirePermissions('expenses.read', 'any')
  async receipt(@CurrentUser() u: AuthPrincipal, @Param('id', ID) id: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.expenses.receipt(u, id);
    res.setHeader('Cache-Control', 'private, no-store');
    if (r.file.kind === 'redirect') {
      res.redirect(302, r.file.url);
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    return new StreamableFile(r.file.body, { type: r.contentType, disposition: `inline; filename="${r.filename}"` });
  }
}
