import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { TOPICS } from '../topics';

export class EventsQuery {
  @ApiProperty() @IsUUID() branchId: string;
  @ApiProperty({ description: 'The last event id the client processed (0 for none)' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  after: number;
  @ApiPropertyOptional({ enum: TOPICS, isArray: true, description: 'Comma-separated; default every topic you can see' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',') : value))
  @IsArray()
  @IsIn(TOPICS, { each: true })
  topics?: string[];
  @ApiPropertyOptional({ default: 200, maximum: 1000 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) limit = 200;
}
