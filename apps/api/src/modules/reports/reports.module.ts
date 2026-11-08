import { Module } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { OperationsReportsService } from './operations-reports.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  controllers: [ReportsController],
  providers: [ReportsService, OperationsReportsService, DashboardService],
})
export class ReportsModule {}
