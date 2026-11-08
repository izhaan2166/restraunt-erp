import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { KitchenStationsController } from './kitchen-stations.controller';
import { KitchenStationsService } from './kitchen-stations.service';

@Module({ imports: [AuditModule], controllers: [KitchenStationsController], providers: [KitchenStationsService] })
export class KitchenStationsModule {}
