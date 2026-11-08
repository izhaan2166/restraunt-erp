import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AttendanceStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsEmail, IsEnum, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { DATE_ONLY } from '../../../common/dates';
import { PaginationQuery } from '../../../common/dto/pagination';
import { MONEY } from '../../menu/dto/menu.dto';

const date = (f: string) => ({ message: `${f} must be a date (YYYY-MM-DD)` });
const bool = ({ value }: { value: unknown }) => value === 'true' || value === true;
const CODE = /^[A-Za-z0-9-]{1,20}$/;

export class CreateEmployeeDto {
  @ApiProperty({ example: 'EMP-014' }) @Matches(CODE, { message: 'employeeCode must be 1–20 letters, digits or -' }) employeeCode: string;
  @ApiProperty({ example: 'Ravi Kumar' }) @IsString() @MinLength(2) @MaxLength(120) fullName: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\+?[0-9]{10,15}$/, { message: 'phone must be 10–15 digits' }) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(120) email?: string;
  @ApiPropertyOptional({ example: 'Captain' }) @IsOptional() @IsString() @MaxLength(60) designation?: string;
  @ApiPropertyOptional({ example: '2026-04-01' }) @IsOptional() @Matches(DATE_ONLY, date('joiningDate')) joiningDate?: string;
  @ApiPropertyOptional({ example: '18000.00' }) @IsOptional() @Matches(MONEY, { message: 'monthlySalary must be an amount' }) monthlySalary?: string;
  @ApiPropertyOptional({ description: 'Branch the employee works at' }) @IsOptional() @IsUUID() primaryBranchId?: string;
  @ApiPropertyOptional({ description: 'Their login account (a user of this organization)' }) @IsOptional() @IsUUID() userId?: string;
}

export class UpdateEmployeeDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(120) fullName?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\+?[0-9]{10,15}$/, { message: 'phone must be 10–15 digits' }) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(120) email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) designation?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(DATE_ONLY, date('joiningDate')) joiningDate?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(MONEY, { message: 'monthlySalary must be an amount' }) monthlySalary?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() primaryBranchId?: string;
  @ApiPropertyOptional({ nullable: true, description: 'null unlinks the login account' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  userId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class ListEmployeesQuery extends PaginationQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() branchId?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(bool) @IsBoolean() includeInactive?: boolean;
}

export class ClockInDto {
  @ApiProperty() @IsUUID() branchId: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) notes?: string;
}

export class ClockOutDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) notes?: string;
}

export class RecordAttendanceDto {
  @ApiProperty() @IsUUID() branchId: string;
  @ApiProperty() @IsUUID() employeeId: string;
  @ApiProperty({ example: '2026-11-08' }) @Matches(DATE_ONLY, date('workDate')) workDate: string;
  @ApiProperty({ enum: AttendanceStatus }) @IsEnum(AttendanceStatus) status: AttendanceStatus;
  @ApiPropertyOptional({ example: '2026-11-08T09:00:00+05:30' }) @IsOptional() @IsDateString() clockInAt?: string;
  @ApiPropertyOptional({ example: '2026-11-08T18:00:00+05:30' }) @IsOptional() @IsDateString() clockOutAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) notes?: string;
  @ApiProperty({ example: 'Forgot to clock out' }) @IsString() @MinLength(3) @MaxLength(200) reason: string;
}

export class AttendanceQuery {
  @ApiProperty() @IsUUID() branchId: string;
  @ApiProperty({ example: '2026-11-01' }) @Matches(DATE_ONLY, date('from')) from: string;
  @ApiProperty({ example: '2026-11-30' }) @Matches(DATE_ONLY, date('to')) to: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() employeeId?: string;
}

export class MyAttendanceQuery {
  @ApiProperty({ example: '2026-11-01' }) @Matches(DATE_ONLY, date('from')) from: string;
  @ApiProperty({ example: '2026-11-30' }) @Matches(DATE_ONLY, date('to')) to: string;
}
