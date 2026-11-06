import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PaginationQuery } from '../../../common/dto/pagination';

export class AuditQueryDto extends PaginationQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() branchId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() actorUserId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) entityType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) entityId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) action?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() to?: string;
}
