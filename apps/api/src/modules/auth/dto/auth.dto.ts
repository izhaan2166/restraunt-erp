import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export class LoginDto {
  @ApiProperty({ example: 'cashier.blr@spiceroute.example' })
  @Transform(lower)
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty({ example: 'ChangeMe@2026' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password: string;
}

export class RefreshDto {
  @ApiPropertyOptional({ description: 'Refresh token. Browsers send it as the httpOnly `ros_rt` cookie instead.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  refreshToken?: string;
}

export class ForgotPasswordDto {
  @ApiProperty()
  @Transform(lower)
  @IsEmail()
  @MaxLength(254)
  email: string;
}

export class ResetPasswordDto {
  @ApiProperty()
  @IsString()
  @MaxLength(200)
  token: string;

  @ApiProperty({ minLength: 10, maxLength: 128 })
  @IsString()
  @MaxLength(128)
  newPassword: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @MaxLength(128)
  currentPassword: string;

  @ApiProperty({ minLength: 10, maxLength: 128 })
  @IsString()
  @MaxLength(128)
  newPassword: string;
}

export class TokenPairResponse {
  @ApiProperty() accessToken: string;
  @ApiProperty({ description: 'Seconds until the access token expires' }) expiresIn: number;
  @ApiProperty() refreshToken: string;
  @ApiProperty() refreshExpiresAt: string;
}
