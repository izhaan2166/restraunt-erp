import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { TaxesController } from './taxes.controller';
import { TaxesService } from './taxes.service';

@Module({ imports: [AuditModule], controllers: [TaxesController], providers: [TaxesService], exports: [TaxesService] })
export class TaxesModule {}
