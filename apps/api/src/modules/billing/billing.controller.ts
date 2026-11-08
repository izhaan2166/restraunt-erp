import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser, RequirePermissions } from '../../common/decorators/auth.decorators';
import { requestMeta } from '../../common/http/request-meta';
import { Idempotent } from '../../common/idempotency/idempotency';
import type { AuthPrincipal } from '../auth/principal';
import { BillingService } from './billing.service';
import {
  CancelInvoiceDto,
  CheckoutDto,
  CreateInvoiceDto,
  CreditNoteDto,
  ListInvoicesQuery,
  ListRefundsQuery,
  PaymentInputDto,
  RefundDto,
  RejectRefundDto,
} from './dto/billing.dto';

@ApiTags('billing')
@ApiBearerAuth()
@Controller()
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /** Issue the bill (if not yet issued) and take one or more payments, atomically. */
  @Post('billing/checkout')
  @HttpCode(200)
  @Idempotent()
  @RequirePermissions('billing.checkout', 'any')
  checkout(@CurrentUser() u: AuthPrincipal, @Body() dto: CheckoutDto, @Req() req: Request) {
    return this.billing.checkout(u, dto, requestMeta(req));
  }

  @Get('invoices')
  @RequirePermissions('invoices.read', 'branch')
  list(@CurrentUser() u: AuthPrincipal, @Query() q: ListInvoicesQuery) {
    return this.billing.list(u, q);
  }

  @Post('invoices')
  @Idempotent()
  @RequirePermissions('invoices.create', 'any')
  create(@CurrentUser() u: AuthPrincipal, @Body() dto: CreateInvoiceDto, @Req() req: Request) {
    return this.billing.createInvoice(u, dto.orderId, dto, requestMeta(req));
  }

  @Get('invoices/:id')
  @RequirePermissions('invoices.read', 'any')
  get(@CurrentUser() u: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.billing.get(u, id);
  }

  @Post('invoices/:id/payments')
  @Idempotent()
  @RequirePermissions('payments.create', 'any')
  pay(@CurrentUser() u: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PaymentInputDto, @Req() req: Request) {
    return this.billing.pay(u, id, dto, req.header('idempotency-key') ?? null, requestMeta(req));
  }

  @Post('invoices/:id/refunds')
  @Idempotent()
  @RequirePermissions('refunds.create', 'any')
  refund(@CurrentUser() u: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RefundDto, @Req() req: Request) {
    return this.billing.refund(u, id, dto, req.header('idempotency-key') ?? null, requestMeta(req));
  }

  @Post('invoices/:id/credit-notes')
  @RequirePermissions('credit_notes.create', 'any')
  creditNote(@CurrentUser() u: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreditNoteDto, @Req() req: Request) {
    return this.billing.createCreditNote(u, id, dto, requestMeta(req));
  }

  @Post('invoices/:id/cancel')
  @HttpCode(200)
  @RequirePermissions('credit_notes.create', 'any')
  cancel(@CurrentUser() u: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelInvoiceDto, @Req() req: Request) {
    return this.billing.cancelInvoice(u, id, dto.reason, requestMeta(req));
  }

  @Get('refunds')
  @RequirePermissions('payments.read', 'branch')
  listRefunds(@CurrentUser() u: AuthPrincipal, @Query() q: ListRefundsQuery) {
    return this.billing.listRefunds(u, q);
  }

  @Post('refunds/:id/approve')
  @HttpCode(200)
  @RequirePermissions('refunds.approve', 'any')
  approve(@CurrentUser() u: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.billing.decideRefund(u, id, true, null, requestMeta(req));
  }

  @Post('refunds/:id/reject')
  @HttpCode(200)
  @RequirePermissions('refunds.approve', 'any')
  reject(@CurrentUser() u: AuthPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectRefundDto, @Req() req: Request) {
    return this.billing.decideRefund(u, id, false, dto.reason, requestMeta(req));
  }
}
