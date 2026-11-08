import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsISO8601, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const RATE = /^(100(\.0{1,3})?|[0-9]{1,2}(\.[0-9]{1,3})?)$/;

export class CreateTaxRateDto {
  @ApiProperty({ example: 'GST 5% (Restaurant service)' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name: string;

  @ApiProperty({ example: '5', description: 'Total GST rate in percent. CGST and SGST are each half; IGST equals the rate.' })
  @Matches(RATE, { message: 'rate must be a percentage between 0 and 100 with up to 3 decimals' })
  rate: string;

  @ApiPropertyOptional({ example: '0' })
  @IsOptional()
  @Matches(RATE, { message: 'cessRate must be a percentage between 0 and 100' })
  cessRate?: string;

  @ApiPropertyOptional() @IsOptional() @IsISO8601() effectiveFrom?: string;
}

/** Rates are immutable once created (orders snapshot them); create a new rate to change one. */
export class UpdateTaxRateDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() effectiveTo?: string;
}
