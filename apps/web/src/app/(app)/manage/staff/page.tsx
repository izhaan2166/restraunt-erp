'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useToast } from '@/components/toast';
import { Badge, Button, Card, Dialog, Empty, ErrorNote, Input, PageHeader, Select, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useBranch, useSession } from '@/lib/session';
import type { Role, StaffUser } from '@/lib/types';

const POLICY = 'At least 10 characters, with a letter and a digit. Ask them to change it after signing in.';
const meetsPolicy = (p: string) => p.length >= 10 && p.length <= 128 && /[A-Za-z]/.test(p) && /\d/.test(p);
const PHONE = /^\+?[0-9]{10,15}$/;

/** Staff of the selected branch (and organisation-wide staff): add people, give or take away roles, deactivate. */
export default function StaffPage() {
  const branch = useBranch();
  const { me, can } = useSession();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<StaffUser | 'new' | null>(null);

  const users = useQuery({ queryKey: ['staff', branch.id], queryFn: () => api.all<StaffUser>('/users', { branchId: branch.id }) });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<Role[]>('/roles') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['staff'] });

  if (users.isError || roles.isError) return <ErrorNote message={errorMessage(users.error ?? roles.error)} onRetry={() => (users.refetch(), roles.refetch())} />;
  if (!users.data || !roles.data) return <Spinner label="Loading staff" />;

  const branchName = (id: string | null) => (id ? (me?.branches.find((b) => b.id === id)?.name ?? 'Another branch') : 'All branches');
  const q = search.trim().toLowerCase();
  const shown = users.data.filter((u) => (showInactive || u.isActive) && (!q || u.fullName.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)));
  const canCreate = can('users.create') && can('users.assign_roles');

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Staff"
        subtitle={`People who work in ${branch.name}, and people with access to every branch.`}
        actions={
          canCreate && (
            <Button onClick={() => setEditing('new')}>
              <Plus className="size-4" aria-hidden /> Add staff
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <input type="search" aria-label="Search staff" placeholder="Name or email" value={search} onChange={(e) => setSearch(e.target.value)} className="h-10 min-w-0 flex-1 rounded-lg border border-stone-300 px-3" />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show deactivated
        </label>
      </div>
      {shown.length === 0 ? (
        <Empty title="Nobody here yet" />
      ) : (
        <Card>
          <ul className="divide-y divide-stone-100">
            {shown.map((u) => (
              <li key={u.id}>
                <button className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-stone-50" onClick={() => setEditing(u)} data-testid="staff-row">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {u.fullName} {!u.isActive && <Badge tone="red">Deactivated</Badge>} {u.id === me?.user.id && <Badge tone="brand">You</Badge>}
                    </p>
                    <p className="truncate text-xs text-stone-500">
                      {u.email}
                      {u.lastLoginAt ? ` · last signed in ${dateTime(u.lastLoginAt)}` : ' · never signed in'}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {u.roles.map((r) => (
                      <Badge key={r.assignmentId} tone={r.branchId ? 'neutral' : 'violet'}>
                        {r.roleName}
                        {r.branchId !== branch.id ? ` · ${branchName(r.branchId)}` : ''}
                      </Badge>
                    ))}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {editing === 'new' && <NewStaff roles={roles.data} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), refresh())} />}
      {editing && editing !== 'new' && (
        <EditStaff
          user={users.data.find((u) => u.id === editing.id) ?? editing}
          roles={roles.data}
          branchName={branchName}
          onClose={() => setEditing(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

/** Roles that can be given from this screen (Super Admin is managed by Super Admins only). */
const grantable = (roles: Role[]) => roles.filter((r) => r.key !== 'SUPER_ADMIN');

function ScopePicker({ value, onChange }: { value: 'branch' | 'all'; onChange: (v: 'branch' | 'all') => void }) {
  const branch = useBranch();
  const { can } = useSession();
  if (!can('users.assign_roles', null)) return <p className="text-sm text-stone-600">For {branch.name}</p>;
  return (
    <Select label="Where" value={value} onChange={(e) => onChange(e.target.value as 'branch' | 'all')}>
      <option value="branch">{branch.name} only</option>
      <option value="all">All branches</option>
    </Select>
  );
}

function NewStaff({ roles, onClose, onSaved }: { roles: Role[]; onClose: () => void; onSaved: () => void }) {
  const branch = useBranch();
  const toast = useToast();
  const options = grantable(roles);
  const [f, setF] = useState({ fullName: '', email: '', phone: '', password: '', roleId: options.find((r) => r.key === 'WAITER')?.id ?? options[0]?.id ?? '' });
  const [scope, setScope] = useState<'branch' | 'all'>('branch');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const valid = f.fullName.trim().length >= 2 && /\S+@\S+\.\S+/.test(f.email) && (!f.phone || PHONE.test(f.phone)) && meetsPolicy(f.password) && f.roleId;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/users', {
        fullName: f.fullName.trim(),
        email: f.email.trim().toLowerCase(),
        phone: f.phone || undefined,
        password: f.password,
        roles: [{ roleId: f.roleId, branchId: scope === 'all' ? null : branch.id }],
      });
      toast(`${f.fullName.trim()} can now sign in`, 'success');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const role = options.find((r) => r.id === f.roleId);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Add staff"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={!valid}>
            Add
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <ErrorNote message={error} />}
        <Input label="Full name" value={f.fullName} onChange={(e) => set('fullName', e.target.value)} maxLength={120} autoFocus />
        <Input label="Work email" type="email" autoComplete="off" value={f.email} onChange={(e) => set('email', e.target.value)} hint="They sign in with this." />
        <Input label="Phone (optional)" inputMode="tel" value={f.phone} onChange={(e) => set('phone', e.target.value.trim())} error={f.phone && !PHONE.test(f.phone) ? '10 to 15 digits' : null} />
        <Input label="First password" type="text" autoComplete="new-password" value={f.password} onChange={(e) => set('password', e.target.value)} hint={POLICY} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Role" value={f.roleId} onChange={(e) => set('roleId', e.target.value)}>
            {options.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
          <ScopePicker value={scope} onChange={setScope} />
        </div>
        {role?.description && <p className="text-sm text-stone-600">{role.description}</p>}
      </div>
    </Dialog>
  );
}

function EditStaff({ user, roles, branchName, onClose, onChanged }: { user: StaffUser; roles: Role[]; branchName: (id: string | null) => string; onClose: () => void; onChanged: () => void }) {
  const branch = useBranch();
  const { me, can } = useSession();
  const toast = useToast();
  const options = grantable(roles).filter((r) => !user.roles.some((ur) => ur.roleId === r.id && ur.branchId === branch.id));
  const [fullName, setFullName] = useState(user.fullName);
  const [phone, setPhone] = useState(user.phone ?? '');
  const [roleId, setRoleId] = useState(options[0]?.id ?? '');
  const [scope, setScope] = useState<'branch' | 'all'>('branch');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const self = user.id === me?.user.id;

  const run = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      toast(done, 'success');
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const detailsChanged = fullName.trim() !== user.fullName || (phone || null) !== user.phone;
  return (
    <Dialog open onClose={onClose} title={user.fullName} footer={<Button variant="ghost" onClick={onClose}>Close</Button>}>
      <div className="flex flex-col gap-5">
        {error && <ErrorNote message={error} />}
        <section className="flex flex-col gap-3">
          <p className="text-sm text-stone-600">{user.email}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={120} disabled={!can('users.update')} />
            <Input label="Phone" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value.trim())} disabled={!can('users.update')} error={phone && !PHONE.test(phone) ? '10 to 15 digits' : null} />
          </div>
          {detailsChanged && (
            <Button
              className="self-start"
              loading={busy === 'details'}
              disabled={fullName.trim().length < 2 || (!!phone && !PHONE.test(phone))}
              onClick={() => run('details', () => api.patch(`/users/${user.id}`, { fullName: fullName.trim(), ...(phone ? { phone } : {}) }), 'Saved')}
            >
              Save details
            </Button>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Roles</h3>
          {user.roles.length === 0 && <p className="text-sm text-stone-500">No roles: this person cannot do anything yet.</p>}
          <ul className="flex flex-col gap-1">
            {user.roles.map((r) => (
              <li key={r.assignmentId} className="flex items-center justify-between gap-2 rounded-lg bg-stone-50 px-3 py-2 text-sm">
                <span>
                  <span className="font-medium">{r.roleName}</span> · {branchName(r.branchId)}
                </span>
                {can('users.assign_roles') && (
                  <button
                    className="rounded p-1 text-stone-500 hover:bg-red-50 hover:text-red-700 disabled:opacity-40"
                    aria-label={`Remove ${r.roleName} role`}
                    disabled={busy !== null}
                    onClick={() => run(r.assignmentId, () => api.del(`/users/${user.id}/roles/${r.assignmentId}`), `${r.roleName} removed`)}
                  >
                    <X className="size-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
          {can('users.assign_roles') && options.length > 0 && (
            <div className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <Select label="Give role" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
                {options.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
              <ScopePicker value={scope} onChange={setScope} />
              <Button
                variant="secondary"
                className="h-11"
                loading={busy === 'add'}
                disabled={!roleId}
                onClick={() => run('add', () => api.post(`/users/${user.id}/roles`, { roleId, branchId: scope === 'all' ? null : branch.id }), 'Role given')}
              >
                Give
              </Button>
            </div>
          )}
        </section>

        {can('users.update') && !self && (
          <section className="flex flex-col gap-2 border-t border-stone-200 pt-4">
            {user.isActive ? (
              <>
                <p className="text-sm text-stone-600">Deactivating signs them out on every device at once. Their past orders and records stay.</p>
                <Button variant="danger" className="self-start" loading={busy === 'active'} onClick={() => run('active', () => api.patch(`/users/${user.id}`, { isActive: false }), `${user.fullName} deactivated`)}>
                  Deactivate
                </Button>
              </>
            ) : (
              <Button variant="secondary" className="self-start" loading={busy === 'active'} onClick={() => run('active', () => api.patch(`/users/${user.id}`, { isActive: true }), `${user.fullName} can sign in again`)}>
                Reactivate
              </Button>
            )}
          </section>
        )}
      </div>
    </Dialog>
  );
}
