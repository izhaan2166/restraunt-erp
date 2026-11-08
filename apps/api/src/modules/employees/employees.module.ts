import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AttendanceService } from './attendance.service';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';

@Module({ imports: [AuditModule], controllers: [EmployeesController], providers: [EmployeesService, AttendanceService] })
export class EmployeesModule {}
