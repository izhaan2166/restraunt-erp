import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PaginationQuery } from '../../../common/dto/pagination';

export class RoleAssignmentDto {
  @ApiProperty() @IsUUID() roleId: string;

  @ApiPropertyOptional({ nullable: true, description: 'null = all branches of the organization' })
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsUUID()
  branchId: string | null = null;
}

export class CreateUserDto {
  @ApiProperty()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty() @IsString() @MinLength(2) @MaxLength(120) fullName: string;

  @ApiPropertyOptional({ example: '+919876543210' })
  @IsOptional()
  @Matches(/^\+?[0-9]{10,15}$/, { message: 'phone must be 10–15 digits, optionally starting with +' })
  phone?: string;

  @ApiProperty({ description: 'Initial password (10–128 chars, letters and digits)' })
  @IsString()
  @MaxLength(128)
  password: string;

  @ApiProperty({ type: [RoleAssignmentDto] })
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => RoleAssignmentDto)
  roles: RoleAssignmentDto[];
}

export class UpdateUserDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(120) fullName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^\+?[0-9]{10,15}$/, { message: 'phone must be 10–15 digits, optionally starting with +' })
  phone?: string;

  @ApiPropertyOptional({ description: 'false deactivates the user and signs out all their sessions' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ListUsersQuery extends PaginationQuery {
  @ApiPropertyOptional({ description: 'Only users assigned to this branch (or organization-wide)' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  isActive?: boolean;
}
