import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod, PurchaseOrderStatus, SupplierInvoiceStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationQuery } from '../../../common/dto/pagination';
import { MONEY } from '../../menu/dto/menu.dto';
import { PCT, PRICE4, STOCK_QTY } from '../../inventory/dto/inventory.dto';

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);
const csv = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.split(',') : value);

export class SupplierDto {
  @ApiProperty({ example: 'Fresh Farms Pvt Ltd' }) @IsString() @MinLength(2) @MaxLength(120) name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) contactPerson?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\+?[0-9]{10,15}$/, { message: 'phone must be 10–15 digits' }) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(120) email?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(upper) @Matches(GSTIN, { message: 'gstin is not a valid GSTIN' }) gstin?: string;
  @ApiPropertyOptional({ example: '29' }) @IsOptional() @Matches(/^[0-9]{2}$/, { message: 'stateCode must be 2 digits' }) stateCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) address?: string;
  @ApiPropertyOptional({ default: 0 }) @IsOptional() @IsInt() @Min(0) @Max(365) paymentTermsDays?: number;
}

export class UpdateSupplierDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) contactPerson?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\+?[0-9]{10,15}$/, { message: 'phone must be 10–15 digits' }) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(120) email?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(upper) @Matches(GSTIN, { message: 'gstin is not a valid GSTIN' }) gstin?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^[0-9]{2}$/, { message: 'stateCode must be 2 digits' }) stateCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) address?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(365) paymentTermsDays?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class ListSuppliersQuery extends PaginationQuery {
  @ApiPropertyOptional() @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean() includeInactive?: boolean;
}

export class SupplierHistoryQuery {
  @ApiPropertyOptional({ description: 'One branch; default every branch you can see' }) @IsOptional() @IsUUID() branchId?: string;
}

export class PoLineDto {
  @ApiProperty() @IsUUID() ingredientId: string;
  @ApiProperty({ example: 'kg' }) @IsString() @MaxLength(10) unit: string;
  @ApiProperty({ example: '10' }) @Matches(STOCK_QTY, { message: 'quantity must be a number with up to 3 decimals' }) quantity: string;
  @ApiProperty({ example: '320', description: 'Price per unit, before tax' }) @Matches(PRICE4, { message: 'unitPrice must be an amount with up to 4 decimals' }) unitPrice: string;
  @ApiPropertyOptional({ example: '5', description: 'GST % charged by the supplier' }) @IsOptional() @Matches(PCT, { message: 'taxRate must be between 0 and 100' }) taxRate?: string;
}

export class CreatePurchaseOrderDto {
  @ApiProperty() @IsUUID() branchId: string;
  @ApiProperty() @IsUUID() supplierId: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() expectedDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @ApiProperty({ type: [PoLineDto] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => PoLineDto) items: PoLineDto[];
}

export class UpdatePurchaseOrderDto {
  @ApiPropertyOptional() @IsOptional() @IsDateString() expectedDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @ApiPropertyOptional({ type: [PoLineDto], description: 'Replaces every line' })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => PoLineDto)
  items?: PoLineDto[];
}

export class ListPurchaseOrdersQuery extends PaginationQuery {
  @ApiProperty() @IsUUID() branchId: string;
  @ApiPropertyOptional({ enum: PurchaseOrderStatus, isArray: true, description: 'Comma-separated' })
  @IsOptional()
  @Transform(csv)
  @IsArray()
  @IsEnum(PurchaseOrderStatus, { each: true })
  status?: PurchaseOrderStatus[];
  @ApiPropertyOptional() @IsOptional() @IsUUID() supplierId?: string;
  @ApiPropertyOptional({ description: 'Only orders still waiting for (part of) their delivery' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  pending?: boolean;
}

export class ReasonDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(300) reason: string;
}

export class ReceiptLineDto {
  @ApiProperty() @IsUUID() purchaseOrderItemId: string;
  @ApiProperty({ example: '6' }) @Matches(STOCK_QTY, { message: 'quantity must be a number with up to 3 decimals' }) quantity: string;
  @ApiPropertyOptional({ description: 'Actual price per unit if it differs from the order' })
  @IsOptional()
  @Matches(PRICE4, { message: 'unitPrice must be an amount with up to 4 decimals' })
  unitPrice?: string;
}

export class ReceivePurchaseOrderDto {
  @ApiProperty({ type: [ReceiptLineDto] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => ReceiptLineDto) items: ReceiptLineDto[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class DirectReceiptLineDto {
  @ApiProperty() @IsUUID() ingredientId: string;
  @ApiProperty({ example: 'kg' }) @IsString() @MaxLength(10) unit: string;
  @ApiProperty({ example: '5' }) @Matches(STOCK_QTY, { message: 'quantity must be a number with up to 3 decimals' }) quantity: string;
  @ApiProperty({ example: '40' }) @Matches(PRICE4, { message: 'unitPrice must be an amount with up to 4 decimals' }) unitPrice: string;
}

export class DirectReceiptDto {
  @ApiProperty() @IsUUID() branchId: string;
  @ApiProperty() @IsUUID() supplierId: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @ApiProperty({ type: [DirectReceiptLineDto] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => DirectReceiptLineDto) items: DirectReceiptLineDto[];
}

export class ListReceiptsQuery extends PaginationQuery {
  @ApiProperty() @IsUUID() branchId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() supplierId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() purchaseOrderId?: string;
}

export class CreateSupplierInvoiceDto {
  @ApiProperty() @IsUUID() branchId: string;
  @ApiProperty() @IsUUID() supplierId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() purchaseOrderId?: string;
  @ApiPropertyOptional({ type: [String], description: 'Goods receipts this invoice bills' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  goodsReceiptIds?: string[];
  @ApiProperty({ example: 'FF/2026/0912' }) @IsString() @MinLength(1) @MaxLength(40) invoiceNumber: string;
  @ApiProperty({ example: '2026-11-08' }) @IsDateString() invoiceDate: string;
  @ApiPropertyOptional({ description: 'Default: invoice date + supplier payment terms' }) @IsOptional() @IsDateString() dueDate?: string;
  @ApiProperty({ example: '3200.00' }) @Matches(MONEY, { message: 'subtotal must be an amount with up to 2 decimals' }) subtotal: string;
  @ApiProperty({ example: '160.00' }) @Matches(MONEY, { message: 'taxTotal must be an amount with up to 2 decimals' }) taxTotal: string;
}

export class ListSupplierInvoicesQuery extends PaginationQuery {
  @ApiProperty() @IsUUID() branchId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() supplierId?: string;
  @ApiPropertyOptional({ enum: SupplierInvoiceStatus, isArray: true, description: 'Comma-separated' })
  @IsOptional()
  @Transform(csv)
  @IsArray()
  @IsEnum(SupplierInvoiceStatus, { each: true })
  status?: SupplierInvoiceStatus[];
  @ApiPropertyOptional({ description: 'Only unpaid invoices past their due date' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  overdue?: boolean;
}

export class SupplierPaymentDto {
  @ApiProperty() @IsUUID() supplierInvoiceId: string;
  @ApiProperty({ example: '1000.00' }) @Matches(MONEY, { message: 'amount must be an amount with up to 2 decimals' }) amount: string;
  @ApiProperty({ enum: PaymentMethod }) @IsEnum(PaymentMethod) method: PaymentMethod;
  @ApiPropertyOptional({ example: 'NEFT UTR 1234' }) @IsOptional() @IsString() @MaxLength(100) reference?: string;
}

export class ListSupplierPaymentsQuery extends PaginationQuery {
  @ApiProperty() @IsUUID() branchId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() supplierId?: string;
}
