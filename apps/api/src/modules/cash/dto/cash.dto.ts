import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CashSessionStatus } from '@prisma/client';
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { DATE_ONLY } from '../../../common/dates';
import { PaginationQuery } from '../../../common/dto/pagination';
import { MONEY } from '../../menu/dto/menu.dto';

const money = (f: string) => ({ message: `${f} must be an amount with up to 2 decimals` });
const date = (f: string) => ({ message: `${f} must be a date (YYYY-MM-DD)` });

export class OpenShiftDto {
  @ApiProperty() @IsUUID() branchId: string;
  @ApiProperty({ example: '2000.00', description: 'Cash counted into the drawer at the start' }) @Matches(MONEY, money('openingBalance')) openingBalance: string;
  @ApiPropertyOptional({ example: 'Counter 1' }) @IsOptional() @IsString() @MaxLength(40) terminal?: string;
}

export class BranchOnlyQuery {
  @ApiProperty() @IsUUID() branchId: string;
}

export class CashMovementDto {
  @ApiProperty({ enum: ['CASH_IN', 'CASH_OUT'], description: 'CASH_IN: change added; CASH_OUT: cash taken out (bank deposit, petty cash)' })
  @IsIn(['CASH_IN', 'CASH_OUT'])
  type: 'CASH_IN' | 'CASH_OUT';
  @ApiProperty({ example: '500.00' }) @Matches(MONEY, money('amount')) amount: string;
  @ApiProperty({ example: 'Change from bank' }) @IsString() @MinLength(3) @MaxLength(200) reason: string;
}

export class CloseShiftDto {
  @ApiProperty({ example: '8450.00', description: 'Cash counted in the drawer at closing' }) @Matches(MONEY, money('actualCash')) actualCash: string;
  @ApiPropertyOptional({ description: 'Required when the count differs from the expected cash' }) @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class ListShiftsQuery extends PaginationQuery {
  @ApiProperty() @IsUUID() branchId: string;
  @ApiPropertyOptional({ enum: CashSessionStatus }) @IsOptional() @IsIn(Object.values(CashSessionStatus)) status?: CashSessionStatus;
  @ApiPropertyOptional({ description: 'Cashier (user id)' }) @IsOptional() @IsUUID() userId?: string;
  @ApiPropertyOptional({ example: '2026-11-01', description: 'Opened on or after (India date)' }) @IsOptional() @Matches(DATE_ONLY, date('from')) from?: string;
  @ApiPropertyOptional({ example: '2026-11-30', description: 'Opened on or before (India date)' }) @IsOptional() @Matches(DATE_ONLY, date('to')) to?: string;
}

export class ShiftSummaryQuery {
  @ApiProperty() @IsUUID() branchId: string;
  @ApiProperty({ example: '2026-11-01' }) @Matches(DATE_ONLY, date('from')) from: string;
  @ApiProperty({ example: '2026-11-30' }) @Matches(DATE_ONLY, date('to')) to: string;
}
