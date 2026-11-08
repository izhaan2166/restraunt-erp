import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { ENV, Env } from '../../config/env';
import { AuditModule } from '../audit/audit.module';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';

@Module({
  imports: [
    AuditModule,
    // In memory (bounded) so the file is identified by its bytes before it is stored.
    MulterModule.registerAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({ limits: { fileSize: env.UPLOAD_MAX_RECEIPT_BYTES, files: 1, fields: 0 } }),
    }),
  ],
  controllers: [ExpensesController],
  providers: [ExpensesService],
})
export class ExpensesModule {}
