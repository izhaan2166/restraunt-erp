'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useToast } from '@/components/toast';
import { Badge, Button, Card, Dialog, Empty, ErrorNote, Input, PageHeader, Select, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { indiaDate, monthOf, shortDate, time } from '@/lib/format';
import { useBranch, useSession } from '@/lib/session';
import type { AttendanceRow, AttendanceStatus, Employee } from '@/lib/types';

const STATUS: Record<AttendanceStatus, { label: string; tone: 'green' | 'amber' | 'red' | 'blue' }> = {
  PRESENT: { label: 'Present', tone: 'green' },
  HALF_DAY: { label: 'Half day', tone: 'amber' },
  ABSENT: { label: 'Absent', tone: 'red' },
  LEAVE: { label: 'On leave', tone: 'blue' },
};

interface SummaryRow {
  employee: { id: string; fullName: string; employeeCode: string };
  present: number;
  halfDays: number;
  absent: number;
  leave: number;
  hours: string;
  stillClockedIn: number;
}

/** "HH:MM" in India time, for the time inputs. */
function hhmm(iso: string | null): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

const hours = (h: string) => `${Number(h).toLocaleString('en-IN', { maximumFractionDigits: 1 })} h`;

/** Who came in on a day, and each person's month. Staff clock in themselves; managers fix mistakes with a reason. */
export default function AttendancePage() {
  const branch = useBranch();
  const [day, setDay] = useState(() => indiaDate());
  const [editing, setEditing] = useState<{ employee: Employee; row: AttendanceRow | null } | null>(null);
  const employees = useQuery({ queryKey: ['employees', branch.id], queryFn: () => api.all<Employee>('/employees', { branchId: branch.id }) });
  const rows = useQuery({ queryKey: ['attendance', branch.id, day], queryFn: () => api.get<AttendanceRow[]>('/attendance', { branchId: branch.id, from: day, to: day }), refetchOnMount: 'always', refetchInterval: 30_000 });
  const { from, to } = monthOf(day);
  const summary = useQuery({ queryKey: ['attendance', branch.id, 'summary', from], queryFn: () => api.get<SummaryRow[]>('/attendance/summary', { branchId: branch.id, from, to }) });
  const { can } = useSession();
  const manage = can('attendance.manage', branch.id);

  const error = employees.error ?? rows.error;
  if (error) return <ErrorNote message={errorMessage(error)} onRetry={() => (employees.refetch(), rows.refetch())} />;
  if (!employees.data || !rows.data) return <Spinner label="Loading attendance" />;
  const byEmployee = new Map(rows.data.map((r) => [r.employeeId, r]));
  const people = employees.data.filter((e) => e.isActive || byEmployee.has(e.id));
  const counted = rows.data.filter((r) => r.status === 'PRESENT' || r.status === 'HALF_DAY').length;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Attendance" subtitle={`Who worked at ${branch.name}. Staff clock in and out from the top bar.`} />
      <div className="flex flex-wrap items-end gap-3">
        <Input label="Day" type="date" value={day} max={indiaDate()} onChange={(e) => e.target.value && setDay(e.target.value)} className="w-44" />
        <p className="pb-2 text-sm text-stone-600">
          {counted} of {people.length} in on {shortDate(day)}
        </p>
      </div>
      {people.length === 0 ? (
        <Empty title="No employees yet">Add people on the Employees tab first.</Empty>
      ) : (
        <Card>
          <ul className="divide-y divide-stone-100">
            {people.map((e) => {
              const r = byEmployee.get(e.id) ?? null;
              return (
                <li key={e.id} className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="attendance-row">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {e.fullName} <span className="text-xs font-normal text-stone-500">{e.employeeCode}</span>
                    </p>
                    <p className="text-xs text-stone-500">
                      {r?.clockInAt ? `In ${time(r.clockInAt)}${r.clockOutAt ? ` · out ${time(r.clockOutAt)} · ${hours(r.hoursWorked)}` : ' · still in'}` : r ? '' : 'Not recorded'}
                      {r?.notes && ` · ${r.notes}`}
                    </p>
                  </div>
                  {r && <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>}
                  {manage && (
                    <Button size="sm" variant="secondary" onClick={() => setEditing({ employee: e, row: r })} aria-label={`${r ? 'Correct' : 'Record'} ${e.fullName}`}>
                      {r ? 'Correct' : 'Record'}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      <section aria-labelledby="month" className="flex flex-col gap-2">
        <h2 id="month" className="text-lg font-semibold">
          {new Date(`${from}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })}
        </h2>
        {summary.isError ? (
          <ErrorNote message={errorMessage(summary.error)} onRetry={() => summary.refetch()} />
        ) : !summary.data ? (
          <Spinner />
        ) : summary.data.length === 0 ? (
          <p className="text-sm text-stone-500">Nothing recorded this month yet.</p>
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-stone-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Employee</th>
                  <th className="px-4 py-2 text-right font-medium">Present</th>
                  <th className="px-4 py-2 text-right font-medium">Half days</th>
                  <th className="px-4 py-2 text-right font-medium">Absent</th>
                  <th className="px-4 py-2 text-right font-medium">Leave</th>
                  <th className="px-4 py-2 text-right font-medium">Hours</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {summary.data.map((s) => (
                  <tr key={s.employee.id}>
                    <td className="px-4 py-2">{s.employee.fullName}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{s.present}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{s.halfDays}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{s.absent}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{s.leave}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{hours(s.hours)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </section>
      {editing && <RecordDialog day={day} employee={editing.employee} row={editing.row} onClose={() => setEditing(null)} />}
    </div>
  );
}

function RecordDialog({ day, employee, row, onClose }: { day: string; employee: Employee; row: AttendanceRow | null; onClose: () => void }) {
  const branch = useBranch();
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<AttendanceStatus>(row?.status ?? 'PRESENT');
  const [inAt, setInAt] = useState(hhmm(row?.clockInAt ?? null));
  const [outAt, setOutAt] = useState(hhmm(row?.clockOutAt ?? null));
  const [notes, setNotes] = useState(row?.notes ?? '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const away = status === 'ABSENT' || status === 'LEAVE';
  // A clock-out earlier than the clock-in is taken as after midnight, for a late shift.
  const outDate = outAt && inAt && outAt < inAt ? indiaDate(new Date(new Date(`${day}T12:00:00+05:30`).getTime() + 86_400_000)) : day;

  const problem = !away && outAt && !inAt ? 'Add the time they came in' : reason.trim().length < 3 ? 'Say why you are recording this' : null;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.put('/attendance', {
        branchId: branch.id,
        employeeId: employee.id,
        workDate: day,
        status,
        clockInAt: !away && inAt ? `${day}T${inAt}:00+05:30` : undefined,
        clockOutAt: !away && outAt ? `${outDate}T${outAt}:00+05:30` : undefined,
        notes: notes.trim() || undefined,
        reason: reason.trim(),
      });
      await qc.invalidateQueries({ queryKey: ['attendance', branch.id] });
      toast(`${employee.fullName}: ${STATUS[status].label.toLowerCase()} on ${shortDate(day)}`, 'success');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${employee.fullName} · ${shortDate(day)}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!!problem} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <ErrorNote message={error} />}
        <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value as AttendanceStatus)}>
          {(Object.keys(STATUS) as AttendanceStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS[s].label}
            </option>
          ))}
        </Select>
        {!away && (
          <div className="grid grid-cols-2 gap-3">
            <Input label="Came in" type="time" value={inAt} onChange={(e) => setInAt(e.target.value)} />
            <Input label="Left" type="time" value={outAt} hint={outDate !== day ? 'Next day' : undefined} onChange={(e) => setOutAt(e.target.value)} />
          </div>
        )}
        <Input label="Note (optional)" value={notes} maxLength={200} onChange={(e) => setNotes(e.target.value)} />
        <Input label="Why" value={reason} maxLength={200} placeholder={row ? 'Forgot to clock out' : 'Called in sick'} onChange={(e) => setReason(e.target.value)} />
      </div>
    </Dialog>
  );
}
