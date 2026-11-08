import { AuditModule } from '../audit/audit.module';
import { Module } from '@nestjs/common';
import { TablesController } from './tables.controller';
import { TablesService } from './tables.service';

@Module({ imports: [AuditModule], controllers: [TablesController], providers: [TablesService], exports: [TablesService] })
export class TablesModule {}
