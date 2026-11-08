import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateStationDto {
  @ApiProperty({ example: 'BEV' })
  @Matches(/^[A-Z0-9_-]{2,20}$/, { message: 'code must be 2–20 chars of A–Z, 0–9, _ or -' })
  code: string;

  @ApiProperty({ example: 'Beverage Counter' })
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name: string;
}

export class UpdateStationDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(60) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
