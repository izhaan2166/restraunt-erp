import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { RoundingMode, StockDeductionPolicy, TaxPricingMode } from '@prisma/client';
import { IsBoolean, IsEnum, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export class CreateBranchDto {
  @ApiProperty({ example: 'BLR-IND' })
  @Matches(/^[A-Z0-9-]{2,20}$/, { message: 'code must be 2–20 chars of A–Z, 0–9 or -' })
  code: string;

  @ApiProperty({ example: 'Spice Route – Indiranagar' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @ApiProperty({ example: '29', description: 'GST state code of the branch (two digits)' })
  @Matches(/^[0-9]{2}$/)
  stateCode: string;

  @ApiPropertyOptional({ example: '29ABCDE1234F1Z5' })
  @IsOptional()
  @Matches(GSTIN_REGEX, { message: 'gstin is not a valid GSTIN' })
  gstin?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) city?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^[1-9][0-9]{5}$/) pincode?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\+?[0-9]{10,15}$/) phone?: string;
}

export class UpdateBranchDto extends PartialType(CreateBranchDto) {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateBranchSettingsDto {
  @ApiPropertyOptional({ enum: TaxPricingMode, description: 'Menu prices include GST (INCLUSIVE) or GST is added on top (EXCLUSIVE)' })
  @IsOptional()
  @IsEnum(TaxPricingMode)
  taxPricingMode?: TaxPricingMode;

  @ApiPropertyOptional({ enum: RoundingMode }) @IsOptional() @IsEnum(RoundingMode) roundingMode?: RoundingMode;

  @ApiPropertyOptional({ example: 'BLR1', description: 'Starts invoice, credit note, PO and GRN numbers; a new prefix starts a new series' })
  @IsOptional()
  @Matches(/^[A-Z0-9]{2,10}$/, { message: 'invoicePrefix must be 2–10 chars of A–Z or 0–9' })
  invoicePrefix?: string;

  @ApiPropertyOptional({ enum: StockDeductionPolicy, description: 'When sold items take ingredients out of stock' })
  @IsOptional()
  @IsEnum(StockDeductionPolicy)
  stockDeductionPolicy?: StockDeductionPolicy;

  @ApiPropertyOptional({ description: 'false: items cannot be sent to the kitchen without enough stock' })
  @IsOptional()
  @IsBoolean()
  allowNegativeStock?: boolean;

  @ApiPropertyOptional({ description: 'true (default): cash payments and cash refunds need the cashier to have an open cash shift' })
  @IsOptional()
  @IsBoolean()
  cashRequiresShift?: boolean;

  @ApiPropertyOptional({ example: '5' })
  @IsOptional()
  @Matches(/^(100(\.0{1,3})?|[0-9]{1,2}(\.[0-9]{1,3})?)$/, { message: 'serviceChargePercent must be between 0 and 100' })
  serviceChargePercent?: string;

  @ApiPropertyOptional({ example: '10' })
  @IsOptional()
  @Matches(/^(100(\.0{1,3})?|[0-9]{1,2}(\.[0-9]{1,3})?)$/, { message: 'maxCashierDiscountPct must be between 0 and 100' })
  maxCashierDiscountPct?: string;
}
