import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';

@Module({ imports: [AuditModule], controllers: [OrganizationsController], providers: [OrganizationsService] })
export class OrganizationsModule {}
