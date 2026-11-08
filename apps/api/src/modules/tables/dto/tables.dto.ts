import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
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

const SHAPES = ['RECT', 'ROUND'] as const;

export class CreateTableDto {
  @ApiProperty({ example: 'T1' }) @IsString() @MinLength(1) @MaxLength(20) label: string;
  @ApiPropertyOptional({ example: 'Rooftop' }) @IsOptional() @IsString() @MaxLength(50) area?: string;
  @ApiProperty({ example: 4 }) @IsInt() @Min(1) @Max(100) capacity: number;
  @ApiPropertyOptional({ enum: SHAPES }) @IsOptional() @IsIn(SHAPES) shape?: (typeof SHAPES)[number];
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(10000) posX?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(10000) posY?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(10) @Max(2000) width?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(10) @Max(2000) height?: number;
}

export class UpdateTableDto extends PartialType(CreateTableDto) {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional({ description: 'Optimistic concurrency: the version you last read' })
  @IsOptional()
  @IsInt()
  @Min(0)
  version?: number;
}

export class LayoutItemDto {
  @ApiProperty() @IsUUID() id: string;
  @ApiProperty() @IsInt() @Min(0) @Max(10000) posX: number;
  @ApiProperty() @IsInt() @Min(0) @Max(10000) posY: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(10) @Max(2000) width?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(10) @Max(2000) height?: number;
  @ApiPropertyOptional({ enum: SHAPES }) @IsOptional() @IsIn(SHAPES) shape?: (typeof SHAPES)[number];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) area?: string;
}

export class SaveLayoutDto {
  @ApiProperty({ type: [LayoutItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => LayoutItemDto)
  tables: LayoutItemDto[];
}

export class OpenTableDto {
  @ApiProperty({ example: 2 }) @IsInt() @Min(1) @Max(100) guestCount: number;
}

export class TransferTableDto {
  @ApiProperty() @IsUUID() toTableId: string;
}

export class MergeTablesDto {
  @ApiProperty({ type: [String], description: 'Occupied tables whose sessions and orders join this table' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  tableIds: string[];
}

export class ReserveTableDto {
  @ApiProperty({ example: 'Sharma party' }) @IsString() @MinLength(1) @MaxLength(80) name: string;
  @ApiPropertyOptional({ example: '9876543210' })
  @IsOptional()
  @Matches(/^\+?[0-9]{10,15}$/, { message: 'phone must be 10–15 digits' })
  phone?: string;
  @ApiProperty({ example: '2026-11-08T20:30:00+05:30', description: 'Hold the table until this time' })
  @IsDateString()
  until: string;
}

export class OutOfServiceDto {
  @ApiProperty() @IsBoolean() outOfService: boolean;
}

export class ListTablesQuery {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) area?: string;
}
