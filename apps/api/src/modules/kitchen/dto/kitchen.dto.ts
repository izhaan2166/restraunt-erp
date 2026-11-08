import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { KitchenStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsArray, IsDateString, IsEnum, IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { KITCHEN_TARGETS, type KitchenTarget } from '../kitchen-state';

export class ListTicketsQuery {
  @ApiProperty() @IsUUID() branchId: string;
  @ApiPropertyOptional({ description: 'One station; omit for all stations' }) @IsOptional() @IsUUID() stationId?: string;
  @ApiPropertyOptional({
    enum: KitchenStatus,
    isArray: true,
    description: 'Comma-separated. Default: PENDING,PREPARING,READY (the live board); with updatedSince, every status',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',') : value))
  @IsArray()
  @IsEnum(KitchenStatus, { each: true })
  status?: KitchenStatus[];
  @ApiPropertyOptional({ description: 'Only tickets changed at or after this time (resync after a reconnect)' })
  @IsOptional()
  @IsDateString()
  updatedSince?: string;
  @ApiPropertyOptional({ default: 100, maximum: 500 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit = 100;
}

export class KitchenStatusDto {
  @ApiProperty({ enum: KITCHEN_TARGETS }) @IsIn(KITCHEN_TARGETS) status: KitchenTarget;
}
