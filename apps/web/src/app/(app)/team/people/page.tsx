'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useToast } from '@/components/toast';
import { Badge, Button, Card, Dialog, Empty, ErrorNote, Input, PageHeader, Select, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { MONEY_INPUT, indiaDate, rupees, shortDate } from '@/lib/format';
import { useBranch, useSession } from '@/lib/session';
import type { Employee, StaffUser } from '@/lib/types';

const CODE = /^[A-Za-z0-9-]{1,20}$/;
const PHONE = /^\+?[0-9]{10,15}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Staff records: who works here, since when, and on what pay. A record can be tied to a sign-in. */
export default function PeoplePage() {
  const branch = useBranch();
  const { can } = useSession();
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Employee | 'new' | null>(null);
  const employees = useQuery({ queryKey: ['employees', branch.id, 'all'], queryFn: () => api.all<Employee>('/employees', { branchId: branch.id, includeInactive: true }) });

  if (employees.isError) return <ErrorNote message={errorMessage(employees.error)} onRetry={() => employees.refetch()} />;
  if (!employees.data) return <Spinner label="Loading employees" />;
  const q = search.trim().toLowerCase();
  const shown = employees.data.filter((e) => (showInactive || e.isActive) && (!q || e.fullName.toLowerCase().includes(q) || e.employeeCode.toLowerCase().includes(q) || (e.phone ?? '').includes(q)));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Employees"
        subtitle={`Everyone who works at ${branch.name}.`}
        actions={
          can('employees.manage') && (
            <Button onClick={() => setEditing('new')}>
              <Plus className="size-4" aria-hidden /> Add employee
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <input type="search" aria-label="Search employees" placeholder="Name, code or phone" value={search} onChange={(e) => setSearch(e.target.value)} className="h-10 min-w-0 flex-1 rounded-lg border border-stone-300 px-3" />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show people who left
        </label>
      </div>
      {shown.length === 0 ? (
        <Empty title="No employees yet" />
      ) : (
        <Card>
          <ul className="divide-y divide-stone-100">
            {shown.map((e) => (
              <li key={e.id}>
                <button className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-stone-50" onClick={() => setEditing(e)} data-testid="employee-row">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {e.fullName} <span className="text-xs font-normal text-stone-500">{e.employeeCode}</span> {!e.isActive && <Badge tone="red">Left</Badge>}
                    </p>
                    <p className="truncate text-xs text-stone-500">{[e.designation, e.phone, e.joiningDate && `joined ${shortDate(e.joiningDate)}`].filter(Boolean).join(' · ') || 'No details yet'}</p>
                  </div>
                  {e.user ? <Badge tone="green">Can sign in</Badge> : <Badge>No sign-in</Badge>}
                  {e.monthlySalary && <span className="text-sm tabular-nums">{rupees(e.monthlySalary)} a month</span>}
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {editing && <EmployeeDialog employee={editing === 'new' ? null : editing} taken={employees.data} onClose={() => setEditing(null)} />}
    </div>
  );
}

function EmployeeDialog({ employee, taken, onClose }: { employee: Employee | null; taken: Employee[]; onClose: () => void }) {
  const branch = useBranch();
  const { can, me } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const editable = can('employees.manage');
  const users = useQuery({ queryKey: ['staff', branch.id], queryFn: () => api.all<StaffUser>('/users', { branchId: branch.id }), enabled: editable && can('users.read') });
  const [f, setF] = useState({
    employeeCode: employee?.employeeCode ?? '',
    fullName: employee?.fullName ?? '',
    phone: employee?.phone ?? '',
    email: employee?.email ?? '',
    designation: employee?.designation ?? '',
    joiningDate: employee?.joiningDate?.slice(0, 10) ?? '',
    monthlySalary: employee?.monthlySalary ?? '',
    primaryBranchId: employee?.primaryBranchId ?? branch.id,
    userId: employee?.userId ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const linkedElsewhere = new Set(taken.filter((e) => e.userId && e.id !== employee?.id).map((e) => e.userId));

  const problem = !employee && !CODE.test(f.employeeCode)
    ? 'Give an employee code, like E-102 (letters, digits and -)'
    : f.fullName.trim().length < 2
      ? 'Enter their full name'
      : f.phone && !PHONE.test(f.phone)
        ? 'Phone number should be 10 to 15 digits'
        : f.email && !EMAIL.test(f.email)
          ? 'That email does not look right'
          : f.joiningDate && f.joiningDate > indiaDate()
            ? 'The joining date cannot be in the future'
            : f.monthlySalary && !MONEY_INPUT.test(f.monthlySalary)
              ? 'Salary should be an amount like 18000'
              : null;

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['employees'] });
      toast(done, 'success');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const fields = {
    fullName: f.fullName.trim(),
    phone: f.phone || undefined,
    email: f.email || undefined,
    designation: f.designation.trim() || undefined,
    joiningDate: f.joiningDate || undefined,
    monthlySalary: f.monthlySalary || undefined,
    primaryBranchId: f.primaryBranchId || undefined,
  };
  const save = () =>
    employee
      ? run(() => api.patch(`/employees/${employee.id}`, { ...fields, userId: f.userId || null }), 'Employee saved')
      : run(() => api.post('/employees', { ...fields, employeeCode: f.employeeCode, userId: f.userId || undefined }), `${fields.fullName} added`);

  return (
    <Dialog
      open
      onClose={onClose}
      title={employee ? employee.fullName : 'Add employee'}
      footer={
        <>
          {employee && editable && (
            <Button variant="ghost" className="mr-auto" loading={busy} onClick={() => run(() => api.patch(`/employees/${employee.id}`, { isActive: !employee.isActive }), employee.isActive ? `${employee.fullName} marked as left` : `${employee.fullName} is back`)}>
              {employee.isActive ? 'Mark as left' : 'Rejoined'}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            {editable ? 'Cancel' : 'Close'}
          </Button>
          {editable && (
            <Button loading={busy} disabled={!!problem} onClick={save}>
              {employee ? 'Save' : 'Add employee'}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <ErrorNote message={error} />}
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Employee code" value={f.employeeCode} maxLength={20} disabled={!!employee || !editable} placeholder="E-102" onChange={(e) => set({ employeeCode: e.target.value.toUpperCase().replace(/\s/g, '') })} />
          <Input label="Full name" value={f.fullName} maxLength={120} disabled={!editable} onChange={(e) => set({ fullName: e.target.value })} />
          <Input label="Phone (optional)" type="tel" value={f.phone} maxLength={16} disabled={!editable} onChange={(e) => set({ phone: e.target.value.replace(/[^\d+]/g, '') })} />
          <Input label="Email (optional)" type="email" value={f.email} maxLength={120} disabled={!editable} onChange={(e) => set({ email: e.target.value.trim() })} />
          <Input label="Job (optional)" value={f.designation} maxLength={60} placeholder="Captain, Chef, Helper" disabled={!editable} onChange={(e) => set({ designation: e.target.value })} />
          <Input label="Joined on (optional)" type="date" value={f.joiningDate} max={indiaDate()} disabled={!editable} onChange={(e) => set({ joiningDate: e.target.value })} />
          {(editable || employee?.monthlySalary) && (
            <Input label="Monthly salary (₹, optional)" inputMode="decimal" value={f.monthlySalary} disabled={!editable} onChange={(e) => set({ monthlySalary: e.target.value.trim() })} />
          )}
          <Select label="Works at" value={f.primaryBranchId} disabled={!editable} onChange={(e) => set({ primaryBranchId: e.target.value })}>
            {(me?.branches ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </div>
        {users.data ? (
          <Select label="Their sign-in (optional)" value={f.userId} disabled={!editable} onChange={(e) => set({ userId: e.target.value })}>
            <option value="">No sign-in</option>
            {users.data
              .filter((u) => (u.isActive && !linkedElsewhere.has(u.id)) || u.id === f.userId)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.fullName} ({u.email})
                </option>
              ))}
          </Select>
        ) : (
          employee?.user && <p className="text-sm text-stone-600">Signs in as {employee.user.email}</p>
        )}
        <p className="text-xs text-stone-500">With a sign-in tied to them, they can clock in and out from the top bar.</p>
        {editable && problem && f.fullName && <p className="text-sm text-amber-800">{problem}</p>}
      </div>
    </Dialog>
  );
}
