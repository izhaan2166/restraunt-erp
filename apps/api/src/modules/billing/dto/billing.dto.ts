import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { InvoiceStatus, PaymentMethod } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationQuery } from '../../../common/dto/pagination';
import { MONEY, QTY } from '../../menu/dto/menu.dto';

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export class BuyerDto {
  @ApiPropertyOptional({ example: 'Acme Pvt Ltd' }) @IsOptional() @IsString() @MaxLength(120) buyerName?: string;
  @ApiPropertyOptional({ example: '29AABCA1234F1Z5', description: 'For B2B bills' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Matches(GSTIN, { message: 'buyerGstin is not a valid GSTIN' })
  buyerGstin?: string;
}

export class CreateInvoiceDto extends BuyerDto {
  @ApiProperty() @IsUUID() orderId: string;
}

export class PaymentInputDto {
  @ApiProperty({ enum: PaymentMethod }) @IsEnum(PaymentMethod) method: PaymentMethod;
  @ApiProperty({ example: '500.00' }) @Matches(MONEY, { message: 'amount must be an amount with up to 2 decimals' }) amount: string;
  @ApiPropertyOptional({ description: 'UPI RRN / card approval code' }) @IsOptional() @IsString() @MaxLength(100) reference?: string;
}

export class CheckoutDto extends BuyerDto {
  @ApiProperty() @IsUUID() orderId: string;
  @ApiProperty({ type: [PaymentInputDto], description: 'Split payments allowed; may be empty to print the bill first' })
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => PaymentInputDto)
  payments: PaymentInputDto[];
}

export class RefundDto {
  @ApiProperty() @IsUUID() paymentId: string;
  @ApiProperty({ example: '120.00' }) @Matches(MONEY) amount: string;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(300) reason: string;
  @ApiPropertyOptional({ enum: PaymentMethod, description: 'Defaults to the original payment method' })
  @IsOptional()
  @IsEnum(PaymentMethod)
  method?: PaymentMethod;
  @ApiPropertyOptional({ description: 'The credit note this refund settles' }) @IsOptional() @IsUUID() creditNoteId?: string;
  @ApiPropertyOptional({ default: false, description: 'Return ingredients to stock (applied by inventory in Phase 5)' })
  @IsOptional()
  @IsBoolean()
  restock?: boolean;
}

export class CreditNoteLineDto {
  @ApiProperty() @IsUUID() invoiceItemId: string;
  @ApiProperty({ example: '1' }) @Matches(QTY) quantity: string;
}

export class CreditNoteDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(300) reason: string;
  @ApiProperty({ type: [CreditNoteLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CreditNoteLineDto)
  lines: CreditNoteLineDto[];
}

export class CancelInvoiceDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(300) reason: string;
}

export class RejectRefundDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(300) reason: string;
}

export class ListInvoicesQuery extends PaginationQuery {
  @ApiProperty() @IsUUID() branchId: string;
  @ApiPropertyOptional({ enum: InvoiceStatus }) @IsOptional() @IsEnum(InvoiceStatus) status?: InvoiceStatus;
  @ApiPropertyOptional() @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() to?: string;
}

export class ListRefundsQuery {
  @ApiProperty() @IsUUID() branchId: string;
  @ApiPropertyOptional({ enum: ['PENDING', 'COMPLETED', 'VOIDED'] })
  @IsOptional()
  @IsEnum(['PENDING', 'COMPLETED', 'VOIDED'])
  status?: 'PENDING' | 'COMPLETED' | 'VOIDED';
}
