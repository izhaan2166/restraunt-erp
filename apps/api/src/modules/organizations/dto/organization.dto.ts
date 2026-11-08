import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { GSTIN_REGEX } from '../../branches/dto/branch.dto';

export class UpdateOrganizationDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) legalName?: string;
  @ApiPropertyOptional({ example: '29ABCDE1234F1Z5' })
  @IsOptional()
  @Matches(GSTIN_REGEX, { message: 'gstin is not a valid GSTIN' })
  gstin?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^[A-Z]{5}[0-9]{4}[A-Z]$/, { message: 'pan is not a valid PAN' }) pan?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^[0-9]{2}$/) stateCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) address?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\+?[0-9]{10,15}$/) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
}
