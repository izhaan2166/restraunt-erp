import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { DATE_ONLY } from '../../../common/dates';
import { PaginationQuery } from '../../../common/dto/pagination';
import { MONEY } from '../../menu/dto/menu.dto';

const money = (f: string) => ({ message: `${f} must be an amount with up to 2 decimals` });
const date = (f: string) => ({ message: `${f} must be a date (YYYY-MM-DD)` });
const bool = ({ value }: { value: unknown }) => value === 'true' || value === true;

export class ExpenseCategoryDto {
  @ApiProperty({ example: 'Electricity' }) @IsString() @MinLength(2) @MaxLength(60) name: string;
}

export class UpdateExpenseCategoryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(60) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class ListExpenseCategoriesQuery {
  @ApiPropertyOptional() @IsOptional() @Transform(bool) @IsBoolean() includeInactive?: boolean;
}

export class CreateExpenseDto {
  @ApiProperty() @IsUUID() branchId: string;
  @ApiProperty() @IsUUID() categoryId: string;
  @ApiProperty({ example: '4720.00', description: 'Total paid, GST included' }) @Matches(MONEY, money('amount')) amount: string;
  @ApiPropertyOptional({ example: '720.00', description: 'GST included in the amount (for input tax credit)' })
  @IsOptional()
  @Matches(MONEY, money('taxAmount'))
  taxAmount?: string;
  @ApiProperty({ example: 'Electricity bill October' }) @IsString() @MinLength(3) @MaxLength(300) description: string;
  @ApiProperty({ example: '2026-11-08' }) @Matches(DATE_ONLY, date('expenseDate')) expenseDate: string;
  @ApiProperty({ enum: PaymentMethod }) @IsEnum(PaymentMethod) paymentMethod: PaymentMethod;
  @ApiPropertyOptional({ example: 'BESCOM' }) @IsOptional() @IsString() @MaxLength(120) paidTo?: string;
  @ApiPropertyOptional({ description: 'The employee who spent it or is reimbursed' }) @IsOptional() @IsUUID() employeeId?: string;
  @ApiPropertyOptional({ description: 'Paid in cash out of your open cash drawer' }) @IsOptional() @IsBoolean() fromCashDrawer?: boolean;
}

export class UpdateExpenseDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(MONEY, money('amount')) amount?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(MONEY, money('taxAmount')) taxAmount?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(3) @MaxLength(300) description?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(DATE_ONLY, date('expenseDate')) expenseDate?: string;
  @ApiPropertyOptional({ enum: PaymentMethod }) @IsOptional() @IsEnum(PaymentMethod) paymentMethod?: PaymentMethod;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) paidTo?: string;
  @ApiPropertyOptional({ nullable: true, description: 'null removes the employee' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  employeeId?: string | null;
  @ApiProperty({ example: 'Bill amount corrected' }) @IsString() @MinLength(3) @MaxLength(300) reason: string;
}

export class DeleteExpenseDto {
  @ApiProperty({ example: 'Entered twice' }) @IsString() @MinLength(3) @MaxLength(300) reason: string;
}

export class ListExpensesQuery extends PaginationQuery {
  @ApiProperty() @IsUUID() branchId: string;
  @ApiPropertyOptional({ example: '2026-11-01' }) @IsOptional() @Matches(DATE_ONLY, date('from')) from?: string;
  @ApiPropertyOptional({ example: '2026-11-30' }) @IsOptional() @Matches(DATE_ONLY, date('to')) to?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() employeeId?: string;
  @ApiPropertyOptional({ enum: PaymentMethod }) @IsOptional() @IsEnum(PaymentMethod) paymentMethod?: PaymentMethod;
  @ApiPropertyOptional({ description: 'Show deleted expenses too' }) @IsOptional() @Transform(bool) @IsBoolean() includeDeleted?: boolean;
}

export class ExpenseSummaryQuery {
  @ApiProperty() @IsUUID() branchId: string;
  @ApiProperty({ example: '2026-11-01' }) @Matches(DATE_ONLY, date('from')) from: string;
  @ApiProperty({ example: '2026-11-30' }) @Matches(DATE_ONLY, date('to')) to: string;
}
