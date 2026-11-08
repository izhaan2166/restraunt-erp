import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser, RequirePermissions } from '../../common/decorators/auth.decorators';
import { requestMeta } from '../../common/http/request-meta';
import { Idempotent } from '../../common/idempotency/idempotency';
import type { AuthPrincipal } from '../auth/principal';
import {
  CreatePurchaseOrderDto,
  CreateSupplierInvoiceDto,
  DirectReceiptDto,
  ListPurchaseOrdersQuery,
  ListReceiptsQuery,
  ListSupplierInvoicesQuery,
  ListSupplierPaymentsQuery,
  ListSuppliersQuery,
  ReasonDto,
  ReceivePurchaseOrderDto,
  SupplierDto,
  SupplierHistoryQuery,
  SupplierPaymentDto,
  UpdatePurchaseOrderDto,
  UpdateSupplierDto,
} from './dto/purchasing.dto';
import { PurchasingService } from './purchasing.service';

const ID = new ParseUUIDPipe();

@ApiTags('purchasing')
@ApiBearerAuth()
@Controller()
export class PurchasingController {
  constructor(private readonly purchasing: PurchasingService) {}

  // Suppliers are organization-wide; orders, receipts, invoices and payments belong to a branch.

  @Get('suppliers')
  @RequirePermissions('suppliers.read', 'any')
  listSuppliers(@CurrentUser() u: AuthPrincipal, @Query() q: ListSuppliersQuery) {
    return this.purchasing.listSuppliers(u, q);
  }

  @Get('suppliers/:id')
  @RequirePermissions('suppliers.read', 'any')
  getSupplier(@CurrentUser() u: AuthPrincipal, @Param('id', ID) id: string) {
    return this.purchasing.getSupplier(u, id);
  }

  @Get('suppliers/:id/transactions')
  @RequirePermissions('suppliers.read', 'any')
  supplierTransactions(@CurrentUser() u: AuthPrincipal, @Param('id', ID) id: string, @Query() q: SupplierHistoryQuery) {
    return this.purchasing.supplierTransactions(u, id, q);
  }

  @Post('suppliers')
  @RequirePermissions('suppliers.manage', 'any')
  createSupplier(@CurrentUser() u: AuthPrincipal, @Body() dto: SupplierDto, @Req() req: Request) {
    return this.purchasing.createSupplier(u, dto, requestMeta(req));
  }

  @Patch('suppliers/:id')
  @RequirePermissions('suppliers.manage', 'any')
  updateSupplier(@CurrentUser() u: AuthPrincipal, @Param('id', ID) id: string, @Body() dto: UpdateSupplierDto, @Req() req: Request) {
    return this.purchasing.updateSupplier(u, id, dto, requestMeta(req));
  }

  @Delete('suppliers/:id')
  @HttpCode(204)
  @RequirePermissions('suppliers.manage', 'any')
  deleteSupplier(@CurrentUser() u: AuthPrincipal, @Param('id', ID) id: string, @Req() req: Request) {
    return this.purchasing.deleteSupplier(u, id, requestMeta(req));
  }

  @Get('purchase-orders')
  @RequirePermissions('purchases.read', 'branch')
  listPurchaseOrders(@CurrentUser() u: AuthPrincipal, @Query() q: ListPurchaseOrdersQuery) {
    return this.purchasing.listPurchaseOrders(u, q);
  }

  @Get('purchase-orders/:id')
  @RequirePermissions('purchases.read', 'any')
  getPurchaseOrder(@CurrentUser() u: AuthPrincipal, @Param('id', ID) id: string) {
    return this.purchasing.getPurchaseOrder(u, id);
  }

  @Post('purchase-orders')
  @Idempotent()
  @RequirePermissions('purchases.create', 'branch')
  createPurchaseOrder(@CurrentUser() u: AuthPrincipal, @Body() dto: CreatePurchaseOrderDto, @Req() req: Request) {
    return this.purchasing.createPurchaseOrder(u, dto, requestMeta(req));
  }

  @Patch('purchase-orders/:id')
  @RequirePermissions('purchases.create', 'any')
  updatePurchaseOrder(@CurrentUser() u: AuthPrincipal, @Param('id', ID) id: string, @Body() dto: UpdatePurchaseOrderDto, @Req() req: Request) {
    return this.purchasing.updatePurchaseOrder(u, id, dto, requestMeta(req));
  }

  @Post('purchase-orders/:id/approve')
  @HttpCode(200)
  @RequirePermissions('purchases.approve', 'any')
  approvePurchaseOrder(@CurrentUser() u: AuthPrincipal, @Param('id', ID) id: string, @Req() req: Request) {
    return this.purchasing.approvePurchaseOrder(u, id, requestMeta(req));
  }

  @Post('purchase-orders/:id/cancel')
  @HttpCode(200)
  @RequirePermissions('purchases.create', 'any')
  cancelPurchaseOrder(@CurrentUser() u: AuthPrincipal, @Param('id', ID) id: string, @Body() dto: ReasonDto, @Req() req: Request) {
    return this.purchasing.cancelPurchaseOrder(u, id, dto.reason, requestMeta(req));
  }

  @Post('purchase-orders/:id/receipts')
  @Idempotent()
  @RequirePermissions('purchases.receive', 'any')
  receive(@CurrentUser() u: AuthPrincipal, @Param('id', ID) id: string, @Body() dto: ReceivePurchaseOrderDto, @Req() req: Request) {
    return this.purchasing.receive(u, id, dto, requestMeta(req));
  }

  @Post('goods-receipts')
  @Idempotent()
  @RequirePermissions('purchases.receive', 'branch')
  directReceipt(@CurrentUser() u: AuthPrincipal, @Body() dto: DirectReceiptDto, @Req() req: Request) {
    return this.purchasing.directReceipt(u, dto, requestMeta(req));
  }

  @Get('goods-receipts')
  @RequirePermissions('purchases.read', 'branch')
  listReceipts(@CurrentUser() u: AuthPrincipal, @Query() q: ListReceiptsQuery) {
    return this.purchasing.listReceipts(u, q);
  }

  @Get('goods-receipts/:id')
  @RequirePermissions('purchases.read', 'any')
  getReceipt(@CurrentUser() u: AuthPrincipal, @Param('id', ID) id: string) {
    return this.purchasing.getReceipt(u, id);
  }

  @Post('supplier-invoices')
  @Idempotent()
  @RequirePermissions('supplier_payments.create', 'branch')
  createInvoice(@CurrentUser() u: AuthPrincipal, @Body() dto: CreateSupplierInvoiceDto, @Req() req: Request) {
    return this.purchasing.createInvoice(u, dto, requestMeta(req));
  }

  @Get('supplier-invoices')
  @RequirePermissions('purchases.read', 'branch')
  listInvoices(@CurrentUser() u: AuthPrincipal, @Query() q: ListSupplierInvoicesQuery) {
    return this.purchasing.listInvoices(u, q);
  }

  @Get('supplier-invoices/:id')
  @RequirePermissions('purchases.read', 'any')
  getInvoice(@CurrentUser() u: AuthPrincipal, @Param('id', ID) id: string) {
    return this.purchasing.getInvoice(u, id);
  }

  @Post('supplier-invoices/:id/cancel')
  @HttpCode(200)
  @RequirePermissions('supplier_payments.create', 'any')
  cancelInvoice(@CurrentUser() u: AuthPrincipal, @Param('id', ID) id: string, @Body() dto: ReasonDto, @Req() req: Request) {
    return this.purchasing.cancelInvoice(u, id, dto.reason, requestMeta(req));
  }

  @Post('supplier-payments')
  @Idempotent()
  @RequirePermissions('supplier_payments.create', 'any')
  pay(@CurrentUser() u: AuthPrincipal, @Body() dto: SupplierPaymentDto, @Req() req: Request) {
    return this.purchasing.pay(u, dto, req.header('idempotency-key') ?? null, requestMeta(req));
  }

  @Get('supplier-payments')
  @RequirePermissions('purchases.read', 'branch')
  listPayments(@CurrentUser() u: AuthPrincipal, @Query() q: ListSupplierPaymentsQuery) {
    return this.purchasing.listPayments(u, q);
  }
}
