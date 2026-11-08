import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthenticatedOnly, CurrentUser, RequirePermissions } from '../../common/decorators/auth.decorators';
import { requestMeta } from '../../common/http/request-meta';
import type { AuthPrincipal } from '../auth/principal';
import { AttendanceService } from './attendance.service';
import {
  AttendanceQuery,
  ClockInDto,
  ClockOutDto,
  CreateEmployeeDto,
  ListEmployeesQuery,
  MyAttendanceQuery,
  RecordAttendanceDto,
  UpdateEmployeeDto,
} from './dto/employees.dto';
import { EmployeesService } from './employees.service';

const ID = new ParseUUIDPipe();

@ApiTags('employees')
@ApiBearerAuth()
@Controller()
export class EmployeesController {
  constructor(
    private readonly employees: EmployeesService,
    private readonly attendance: AttendanceService,
  ) {}

  @Get('employees/me')
  @AuthenticatedOnly()
  me(@CurrentUser() u: AuthPrincipal) {
    return this.employees.me(u);
  }

  @Get('employees')
  @RequirePermissions('employees.read', 'any')
  list(@CurrentUser() u: AuthPrincipal, @Query() q: ListEmployeesQuery) {
    return this.employees.list(u, q);
  }

  @Get('employees/:id')
  @RequirePermissions('employees.read', 'any')
  get(@CurrentUser() u: AuthPrincipal, @Param('id', ID) id: string) {
    return this.employees.get(u, id);
  }

  @Get('employees/:id/activity')
  @RequirePermissions('employees.read', 'any')
  activity(@CurrentUser() u: AuthPrincipal, @Param('id', ID) id: string) {
    return this.employees.activity(u, id);
  }

  @Post('employees')
  @RequirePermissions('employees.manage', 'any')
  create(@CurrentUser() u: AuthPrincipal, @Body() dto: CreateEmployeeDto, @Req() req: Request) {
    return this.employees.create(u, dto, requestMeta(req));
  }

  @Patch('employees/:id')
  @RequirePermissions('employees.manage', 'any')
  update(@CurrentUser() u: AuthPrincipal, @Param('id', ID) id: string, @Body() dto: UpdateEmployeeDto, @Req() req: Request) {
    return this.employees.update(u, id, dto, requestMeta(req));
  }

  @Delete('employees/:id')
  @HttpCode(204)
  @RequirePermissions('employees.manage', 'any')
  remove(@CurrentUser() u: AuthPrincipal, @Param('id', ID) id: string, @Req() req: Request) {
    return this.employees.remove(u, id, requestMeta(req));
  }

  @Post('attendance/clock-in')
  @RequirePermissions('attendance.self', 'branch')
  clockIn(@CurrentUser() u: AuthPrincipal, @Body() dto: ClockInDto, @Req() req: Request) {
    return this.attendance.clockIn(u, dto, requestMeta(req));
  }

  @Post('attendance/clock-out')
  @HttpCode(200)
  @RequirePermissions('attendance.self', 'any')
  clockOut(@CurrentUser() u: AuthPrincipal, @Body() dto: ClockOutDto, @Req() req: Request) {
    return this.attendance.clockOut(u, dto, requestMeta(req));
  }

  @Get('attendance/me')
  @AuthenticatedOnly()
  mine(@CurrentUser() u: AuthPrincipal, @Query() q: MyAttendanceQuery) {
    return this.attendance.mine(u, q);
  }

  @Put('attendance')
  @RequirePermissions('attendance.manage', 'branch')
  record(@CurrentUser() u: AuthPrincipal, @Body() dto: RecordAttendanceDto, @Req() req: Request) {
    return this.attendance.record(u, dto, requestMeta(req));
  }

  @Get('attendance/summary')
  @RequirePermissions('employees.read', 'branch')
  summary(@CurrentUser() u: AuthPrincipal, @Query() q: AttendanceQuery) {
    return this.attendance.summary(u, q);
  }

  @Get('attendance')
  @RequirePermissions('employees.read', 'branch')
  listAttendance(@CurrentUser() u: AuthPrincipal, @Query() q: AttendanceQuery) {
    return this.attendance.list(u, q);
  }
}
