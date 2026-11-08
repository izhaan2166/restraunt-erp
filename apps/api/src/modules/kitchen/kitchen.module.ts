import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { OrdersModule } from '../orders/orders.module';
import { KitchenController } from './kitchen.controller';
import { KitchenService } from './kitchen.service';

@Module({ imports: [AuditModule, OrdersModule], controllers: [KitchenController], providers: [KitchenService] })
export class KitchenModule {}
