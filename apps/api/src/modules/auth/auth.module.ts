import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuditModule } from '../audit/audit.module';
import { RbacModule } from '../rbac/rbac.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

@Module({
  imports: [JwtModule.register({}), AuditModule, RbacModule],
  controllers: [AuthController],
  providers: [AuthService, TokenService, PasswordService],
  exports: [AuthService, TokenService, PasswordService],
})
export class AuthModule {}
