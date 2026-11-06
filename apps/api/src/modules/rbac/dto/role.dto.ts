import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayUnique, IsArray, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateRoleDto {
  @ApiProperty({ example: 'SHIFT_SUPERVISOR', description: 'UPPER_SNAKE_CASE, unique within the organization' })
  @Matches(/^[A-Z][A-Z0-9_]{1,49}$/, { message: 'key must be UPPER_SNAKE_CASE (2–50 chars)' })
  key: string;

  @ApiProperty({ example: 'Shift Supervisor' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @ApiProperty({ type: [String], example: ['orders.read', 'orders.cancel'] })
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  permissions: string[];
}

export class UpdateRolePermissionsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  permissions: string[];
}
