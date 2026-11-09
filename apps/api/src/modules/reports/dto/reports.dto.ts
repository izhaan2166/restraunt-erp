import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID, Matches } from 'class-validator';
import { DATE_ONLY } from '../../../common/dates';

const date = (f: string) => ({ message: `${f} must be a date (YYYY-MM-DD)` });

/** json: plain figures; table: the report as the screens show it (labels and column types); csv and pdf: files. */
export const FORMATS = ['json', 'table', 'csv', 'pdf'] as const;
export type ReportFormat = (typeof FORMATS)[number];
export const GROUPINGS = ['day', 'week', 'month', 'year'] as const;
export type Grouping = (typeof GROUPINGS)[number];
export const PRESETS = ['today', 'yesterday', 'this_week', 'this_month', 'custom'] as const;

export class ReportQuery {
  @ApiPropertyOptional({ description: 'One branch; omit for every branch you may see this report for' }) @IsOptional() @IsUUID() branchId?: string;
  @ApiProperty({ example: '2026-11-01', description: 'First business date (India time)' }) @Matches(DATE_ONLY, date('from')) from: string;
  @ApiProperty({ example: '2026-11-30', description: 'Last business date, inclusive' }) @Matches(DATE_ONLY, date('to')) to: string;
  @ApiPropertyOptional({ enum: FORMATS, default: 'json' }) @IsOptional() @IsIn(FORMATS) format?: ReportFormat;
}

export class SalesReportQuery extends ReportQuery {
  @ApiPropertyOptional({ enum: GROUPINGS, default: 'day', description: 'Daily, weekly (Monday start), monthly or annual rows' })
  @IsOptional()
  @IsIn(GROUPINGS)
  groupBy?: Grouping;
}

export class DashboardQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() branchId?: string;
  @ApiPropertyOptional({ enum: PRESETS, default: 'today' }) @IsOptional() @IsIn(PRESETS) range?: (typeof PRESETS)[number];
  @ApiPropertyOptional({ description: 'For range=custom' }) @IsOptional() @Matches(DATE_ONLY, date('from')) from?: string;
  @ApiPropertyOptional({ description: 'For range=custom' }) @IsOptional() @Matches(DATE_ONLY, date('to')) to?: string;
}

