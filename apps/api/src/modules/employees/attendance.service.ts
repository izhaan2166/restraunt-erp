import { Injectable } from '@nestjs/common';
import { Attendance, AttendanceStatus, Prisma } from '@prisma/client';
import { dateOnly, dateRange, istDateOf, todayIst } from '../../common/dates';
import { Errors } from '../../common/errors/app-error';
import type { RequestMeta } from '../../common/http/request-meta';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthPrincipal } from '../auth/principal';
import { AttendanceQuery, ClockInDto, ClockOutDto, MyAttendanceQuery, RecordAttendanceDto } from './dto/employees.dto';

type Tx = Prisma.TransactionClient;
type D = Prisma.Decimal;
const Dec = Prisma.Decimal;
const ZERO = new Dec(0);
const MAX_RANGE_DAYS = 366;
/** A clock-in older than this is treated as forgotten, not as a night shift still running. */
const MAX_SHIFT_MS = 20 * 3600_000;

const EMPLOYEE = { select: { id: true, fullName: true, employeeCode: true } } as const;

export function hoursWorked(a: Pick<Attendance, 'clockInAt' | 'clockOutAt'>): D {
  if (!a.clockInAt || !a.clockOutAt) return ZERO;
  return new Dec(a.clockOutAt.getTime() - a.clockInAt.getTime()).div(3_600_000).toDecimalPlaces(2, Dec.ROUND_HALF_UP);
}

@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Starts today's attendance for the signed-in employee. */
  async clockIn(actor: AuthPrincipal, dto: ClockInDto, meta: RequestMeta) {
    return this.prisma.$transaction(async (tx) => {
      const emp = await this.myEmployee(tx, actor);
      await tx.$queryRaw`SELECT id FROM employees WHERE id = ${emp.id}::uuid FOR UPDATE`;
      const open = await tx.attendance.findFirst({ where: { employeeId: emp.id, clockInAt: { not: null }, clockOutAt: null } });
      if (open) throw Errors.conflict('ALREADY_CLOCKED_IN', `You clocked in at ${open.clockInAt!.toISOString()}; clock out first`, { attendanceId: open.id });
      const workDate = todayIst();
      const today = await tx.attendance.findUnique({ where: { employeeId_workDate: { employeeId: emp.id, workDate } } });
      if (today?.clockInAt) throw Errors.conflict('ALREADY_CLOCKED_OUT', 'You have already clocked in and out today; ask a manager to correct it');
      const now = new Date();
      const row = today
        ? await tx.attendance.update({ where: { id: today.id }, data: { status: 'PRESENT', clockInAt: now, branchId: dto.branchId, notes: dto.notes?.trim() || today.notes } })
        : await tx.attendance.create({
            data: { organizationId: actor.organizationId, branchId: dto.branchId, employeeId: emp.id, workDate, status: 'PRESENT', clockInAt: now, notes: dto.notes?.trim() || null, recordedById: actor.userId },
          });
      await this.log(tx, actor, dto.branchId, 'attendance.clock_in', row.id, undefined, { employeeId: emp.id, workDate: workDate.toISOString().slice(0, 10), clockInAt: now }, meta);
      return this.present(row);
    });
  }

  /** Ends the open attendance (also after midnight for a late shift). */
  async clockOut(actor: AuthPrincipal, dto: ClockOutDto, meta: RequestMeta) {
    return this.prisma.$transaction(async (tx) => {
      const emp = await this.myEmployee(tx, actor);
      await tx.$queryRaw`SELECT id FROM employees WHERE id = ${emp.id}::uuid FOR UPDATE`;
      const open = await tx.attendance.findFirst({ where: { employeeId: emp.id, clockInAt: { not: null }, clockOutAt: null } });
      if (!open) throw Errors.conflict('NOT_CLOCKED_IN', 'You are not clocked in');
      const now = new Date();
      if (now.getTime() - open.clockInAt!.getTime() > MAX_SHIFT_MS) {
        throw Errors.conflict('CLOCK_IN_TOO_OLD', 'Your last clock-in is more than 20 hours old; ask a manager to record the correct times');
      }
      const row = await tx.attendance.update({ where: { id: open.id }, data: { clockOutAt: now, notes: dto.notes?.trim() || open.notes } });
      await this.log(tx, actor, row.branchId, 'attendance.clock_out', row.id, undefined, { employeeId: emp.id, clockOutAt: now, hours: hoursWorked(row) }, meta);
      return this.present(row);
    });
  }

  /** A manager records or corrects a day (absent, leave, half day, or the right times). */
  async record(actor: AuthPrincipal, dto: RecordAttendanceDto, meta: RequestMeta) {
    return this.prisma.$transaction(async (tx) => {
      const emp = await tx.employee.findFirst({ where: { id: dto.employeeId, organizationId: actor.organizationId, deletedAt: null } });
      if (!emp) throw Errors.badRequest('INVALID_EMPLOYEE', 'Unknown employee');
      const workDate = dateOnly(dto.workDate);
      if (workDate > todayIst()) throw Errors.badRequest('FUTURE_DATE', 'Attendance cannot be recorded for a future date');
      const clockInAt = dto.clockInAt ? new Date(dto.clockInAt) : null;
      const clockOutAt = dto.clockOutAt ? new Date(dto.clockOutAt) : null;
      const away = dto.status === 'ABSENT' || dto.status === 'LEAVE';
      if (away && (clockInAt || clockOutAt)) throw Errors.badRequest('TIMES_NOT_ALLOWED', `An employee on ${dto.status.toLowerCase()} has no clock times`);
      if (clockOutAt && !clockInAt) throw Errors.badRequest('CLOCK_IN_REQUIRED', 'A clock-out needs a clock-in');
      if (clockInAt && clockOutAt && clockOutAt < clockInAt) throw Errors.badRequest('INVALID_TIMES', 'Clock-out must be after clock-in');
      if (clockInAt && istDateOf(clockInAt).getTime() !== workDate.getTime()) throw Errors.badRequest('INVALID_TIMES', 'The clock-in must be on the work date (India time)');
      if (clockInAt && clockOutAt && clockOutAt.getTime() - clockInAt.getTime() > MAX_SHIFT_MS) throw Errors.badRequest('INVALID_TIMES', 'A shift cannot be longer than 20 hours');
      if (clockInAt && !clockOutAt) {
        const open = await tx.attendance.findFirst({ where: { employeeId: emp.id, clockInAt: { not: null }, clockOutAt: null, NOT: { workDate } } });
        if (open) throw Errors.conflict('ALREADY_CLOCKED_IN', `${emp.fullName} is still clocked in on another day`);
      }
      const before = await tx.attendance.findUnique({ where: { employeeId_workDate: { employeeId: emp.id, workDate } } });
      const data = { branchId: dto.branchId, status: dto.status, clockInAt, clockOutAt, notes: dto.notes?.trim() || null, recordedById: actor.userId };
      const row = before
        ? await tx.attendance.update({ where: { id: before.id }, data })
        : await tx.attendance.create({ data: { ...data, organizationId: actor.organizationId, employeeId: emp.id, workDate } });
      await this.log(tx, actor, dto.branchId, before ? 'attendance.corrected' : 'attendance.recorded', row.id, before ? this.snapshot(before) : undefined, { ...this.snapshot(row), reason: dto.reason.trim() }, meta);
      return this.present(row);
    });
  }

  async list(actor: AuthPrincipal, q: AttendanceQuery) {
    const rows = await this.prisma.attendance.findMany({
      where: { organizationId: actor.organizationId, branchId: q.branchId, employeeId: q.employeeId, workDate: this.range(q.from, q.to) },
      include: { employee: EMPLOYEE },
      orderBy: [{ workDate: 'desc' }, { clockInAt: 'asc' }],
    });
    return rows.map((r) => this.present(r));
  }

  async mine(actor: AuthPrincipal, q: MyAttendanceQuery) {
    const emp = await this.myEmployee(this.prisma, actor);
    const rows = await this.prisma.attendance.findMany({ where: { employeeId: emp.id, workDate: this.range(q.from, q.to) }, orderBy: { workDate: 'desc' } });
    return rows.map((r) => this.present(r));
  }

  /** Per employee over a period: days present, half days, absences, leave and hours worked. */
  async summary(actor: AuthPrincipal, q: AttendanceQuery) {
    const rows = await this.list(actor, q);
    const out = new Map<string, { employee: { id: string; fullName: string; employeeCode: string }; present: number; halfDays: number; absent: number; leave: number; hours: D; stillClockedIn: number }>();
    for (const r of rows) {
      const e = out.get(r.employeeId) ?? { employee: r.employee, present: 0, halfDays: 0, absent: 0, leave: 0, hours: ZERO, stillClockedIn: 0 };
      const by: Record<AttendanceStatus, () => void> = {
        PRESENT: () => (e.present += 1),
        HALF_DAY: () => (e.halfDays += 1),
        ABSENT: () => (e.absent += 1),
        LEAVE: () => (e.leave += 1),
      };
      by[r.status]();
      e.hours = e.hours.add(r.hoursWorked);
      if (r.clockInAt && !r.clockOutAt) e.stillClockedIn += 1;
      out.set(r.employeeId, e);
    }
    return [...out.values()].sort((a, b) => a.employee.fullName.localeCompare(b.employee.fullName));
  }

  // ───────────── Helpers ─────────────

  private present<T extends Attendance>(a: T) {
    return { ...a, hoursWorked: hoursWorked(a) };
  }

  private range(from: string, to: string) {
    const r = dateRange(from, to)!;
    if ((r.lte!.getTime() - r.gte!.getTime()) / 86_400_000 >= MAX_RANGE_DAYS) throw Errors.badRequest('RANGE_TOO_LONG', `Ask for at most ${MAX_RANGE_DAYS} days at a time`);
    return r;
  }

  private async myEmployee(db: Tx, actor: AuthPrincipal) {
    const emp = await db.employee.findFirst({ where: { userId: actor.userId, organizationId: actor.organizationId, deletedAt: null } });
    if (!emp) throw Errors.unprocessable('EMPLOYEE_PROFILE_REQUIRED', 'Your login is not linked to an employee profile; ask a manager to link it');
    if (!emp.isActive) throw Errors.forbidden('EMPLOYEE_INACTIVE', 'Your employee profile is inactive');
    return emp;
  }

  private snapshot(a: Attendance) {
    return { employeeId: a.employeeId, workDate: a.workDate.toISOString().slice(0, 10), status: a.status, clockInAt: a.clockInAt, clockOutAt: a.clockOutAt, notes: a.notes, branchId: a.branchId };
  }

  private log(tx: Tx, actor: AuthPrincipal, branchId: string, action: string, id: string, before: unknown, after: unknown, meta: RequestMeta) {
    return this.audit.record({ organizationId: actor.organizationId, branchId, actorUserId: actor.userId, action, entityType: 'attendance', entityId: id, before, after, meta }, tx);
  }
}

