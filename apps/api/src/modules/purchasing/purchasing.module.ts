import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PurchasingController } from './purchasing.controller';
import { PurchasingService } from './purchasing.service';

@Module({ imports: [AuditModule], controllers: [PurchasingController], providers: [PurchasingService] })
export class PurchasingModule {}
