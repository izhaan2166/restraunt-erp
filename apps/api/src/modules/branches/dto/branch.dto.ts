import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export class CreateBranchDto {
  @ApiProperty({ example: 'BLR-IND' })
  @Matches(/^[A-Z0-9-]{2,20}$/, { message: 'code must be 2–20 chars of A–Z, 0–9 or -' })
  code: string;

  @ApiProperty({ example: 'Spice Route – Indiranagar' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @ApiProperty({ example: '29', description: 'GST state code of the branch (two digits)' })
  @Matches(/^[0-9]{2}$/)
  stateCode: string;

  @ApiPropertyOptional({ example: '29ABCDE1234F1Z5' })
  @IsOptional()
  @Matches(GSTIN_REGEX, { message: 'gstin is not a valid GSTIN' })
  gstin?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) city?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^[1-9][0-9]{5}$/) pincode?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\+?[0-9]{10,15}$/) phone?: string;
}

export class UpdateBranchDto extends PartialType(CreateBranchDto) {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
