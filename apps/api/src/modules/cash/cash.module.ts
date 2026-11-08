import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CashController } from './cash.controller';
import { CashService } from './cash.service';

@Module({ imports: [AuditModule], controllers: [CashController], providers: [CashService] })
export class CashModule {}
