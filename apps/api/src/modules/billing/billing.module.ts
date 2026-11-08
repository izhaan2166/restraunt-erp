import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { OrdersModule } from '../orders/orders.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';

@Module({ imports: [AuditModule, OrdersModule], controllers: [BillingController], providers: [BillingService] })
export class BillingModule {}
