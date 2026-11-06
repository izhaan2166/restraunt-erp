import { Global, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RbacService } from './rbac.service';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';

@Global()
@Module({
  imports: [AuditModule],
  controllers: [RolesController],
  providers: [RbacService, RolesService],
  exports: [RbacService],
})
export class RbacModule {}
