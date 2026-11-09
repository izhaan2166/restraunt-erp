'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useToast } from '@/components/toast';
import { Badge, Button, Card, Dialog, ErrorNote, Input, PageHeader, Select, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useBranch, useSession } from '@/lib/session';
import type { KitchenStation } from '@/lib/types';

interface BranchFull {
  id: string;
  code: string;
  name: string;
  stateCode: string;
  gstin: string | null;
  address: string | null;
  city: string | null;
  pincode: string | null;
  phone: string | null;
  isActive: boolean;
}

interface Settings {
  taxPricingMode: 'INCLUSIVE' | 'EXCLUSIVE';
  roundingMode: 'NEAREST_RUPEE' | 'NEAREST_PAISA';
  invoicePrefix: string;
  stockDeductionPolicy: 'ON_ORDER_CONFIRM' | 'ON_ORDER_COMPLETE' | 'NONE';
  allowNegativeStock: boolean;
  cashRequiresShift: boolean;
  serviceChargePercent: string;
  maxCashierDiscountPct: string;
}

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PERCENT = /^(100(\.0{1,3})?|[0-9]{1,2}(\.[0-9]{1,3})?)$/;

/** Branch details (address, GSTIN), how billing works in the branch, and its kitchen stations. */
export default function BranchesPage() {
  const current = useBranch();
  const { me, can, reload } = useSession();
  const [selectedId, setSelectedId] = useState(current.id);
  const [creating, setCreating] = useState(false);

  const branches = useQuery({ queryKey: ['branches'], queryFn: () => api.get<BranchFull[]>('/branches') });
  if (branches.isError) return <ErrorNote message={errorMessage(branches.error)} onRetry={() => branches.refetch()} />;
  if (!branches.data) return <Spinner label="Loading branches" />;

  const selected = branches.data.find((b) => b.id === selectedId) ?? branches.data[0];
  const canCreate = me?.permissions.organizationWide.includes('branches.create') ?? false;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Branches"
        subtitle="Address and GST details printed on bills, and how each branch bills."
        actions={
          canCreate && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden /> New branch
            </Button>
          )
        }
      />
      {branches.data.length > 1 && (
        <div role="tablist" aria-label="Branch" className="flex gap-2 overflow-x-auto">
          {branches.data.map((b) => (
            <button
              key={b.id}
              role="tab"
              aria-selected={selected?.id === b.id}
              onClick={() => setSelectedId(b.id)}
              className={cn('h-9 shrink-0 rounded-full px-4 text-sm font-medium', selected?.id === b.id ? 'bg-brand-600 text-white' : 'bg-stone-100 text-stone-700')}
            >
              {b.name}
              {!b.isActive && ' (closed)'}
            </button>
          ))}
        </div>
      )}
      {selected && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Details key={`d-${selected.id}`} branch={selected} editable={can('branches.update', selected.id)} />
          <div className="flex flex-col gap-4">
            {can('settings.read', selected.id) && <BillingSettings key={`s-${selected.id}`} branchId={selected.id} editable={can('settings.update', selected.id)} />}
            <Stations key={`k-${selected.id}`} branchId={selected.id} editable={can('menu.manage', selected.id)} />
          </div>
        </div>
      )}
      {creating && (
        <NewBranch
          onClose={() => setCreating(false)}
          onCreated={async (id) => {
            setCreating(false);
            await Promise.all([branches.refetch(), reload()]);
            setSelectedId(id);
          }}
        />
      )}
    </div>
  );
}

function useSaver() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      toast(done, 'success');
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

type DetailsForm = Pick<BranchFull, 'name' | 'stateCode'> & { gstin: string; address: string; city: string; pincode: string; phone: string };
const toForm = (b?: BranchFull): DetailsForm => ({
  name: b?.name ?? '',
  stateCode: b?.stateCode ?? '',
  gstin: b?.gstin ?? '',
  address: b?.address ?? '',
  city: b?.city ?? '',
  pincode: b?.pincode ?? '',
  phone: b?.phone ?? '',
});
function detailsProblem(f: DetailsForm) {
  if (f.name.trim().length < 2) return 'Enter the branch name';
  if (!/^[0-9]{2}$/.test(f.stateCode)) return 'State code is the two digits that start the GSTIN, for example 29 for Karnataka';
  if (f.gstin && !GSTIN.test(f.gstin)) return 'That GSTIN does not look right';
  if (f.gstin && f.gstin.slice(0, 2) !== f.stateCode) return 'The GSTIN should start with the state code';
  if (f.pincode && !/^[1-9][0-9]{5}$/.test(f.pincode)) return 'Pincode is six digits';
  if (f.phone && !/^\+?[0-9]{10,15}$/.test(f.phone)) return 'Phone number should be 10 to 15 digits';
  return null;
}
/** Empty optional fields are left out, so the server keeps them as they are. */
const payload = (f: DetailsForm) => ({
  name: f.name.trim(),
  stateCode: f.stateCode,
  ...(f.gstin && { gstin: f.gstin }),
  ...(f.address.trim() && { address: f.address.trim() }),
  ...(f.city.trim() && { city: f.city.trim() }),
  ...(f.pincode && { pincode: f.pincode }),
  ...(f.phone && { phone: f.phone }),
});

function DetailsFields({ f, set, disabled }: { f: DetailsForm; set: (p: Partial<DetailsForm>) => void; disabled?: boolean }) {
  return (
    <>
      <Input label="Branch name" value={f.name} maxLength={120} disabled={disabled} onChange={(e) => set({ name: e.target.value })} />
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3">
        <Input label="State code" inputMode="numeric" maxLength={2} value={f.stateCode} disabled={disabled} onChange={(e) => set({ stateCode: e.target.value.replace(/\D/g, '') })} />
        <Input label="GSTIN" value={f.gstin} maxLength={15} disabled={disabled} onChange={(e) => set({ gstin: e.target.value.toUpperCase().replace(/\s/g, '') })} />
      </div>
      <Input label="Address" value={f.address} maxLength={300} disabled={disabled} onChange={(e) => set({ address: e.target.value })} />
      <div className="grid grid-cols-2 gap-3">
        <Input label="City" value={f.city} maxLength={80} disabled={disabled} onChange={(e) => set({ city: e.target.value })} />
        <Input label="Pincode" inputMode="numeric" maxLength={6} value={f.pincode} disabled={disabled} onChange={(e) => set({ pincode: e.target.value.replace(/\D/g, '') })} />
      </div>
      <Input label="Phone" type="tel" value={f.phone} maxLength={16} disabled={disabled} onChange={(e) => set({ phone: e.target.value.replace(/[^\d+]/g, '') })} />
    </>
  );
}

function Details({ branch, editable }: { branch: BranchFull; editable: boolean }) {
  const qc = useQueryClient();
  const { reload } = useSession();
  const [f, setF] = useState(() => toForm(branch));
  const s = useSaver();
  const problem = detailsProblem(f);
  const set = (p: Partial<DetailsForm>) => setF((x) => ({ ...x, ...p }));

  const save = () =>
    s.run(async () => {
      await api.patch(`/branches/${branch.id}`, payload(f));
      await Promise.all([qc.invalidateQueries({ queryKey: ['branches'] }), reload()]);
    }, 'Branch details saved');

  const setActive = (isActive: boolean) =>
    s.run(async () => {
      await api.patch(`/branches/${branch.id}`, { isActive });
      await qc.invalidateQueries({ queryKey: ['branches'] });
    }, isActive ? 'Branch reopened' : 'Branch closed');

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">Details</h2>
        <span className="text-sm text-stone-500">
          Code {branch.code} {!branch.isActive && <Badge tone="red">Closed</Badge>}
        </span>
      </div>
      <DetailsFields f={f} set={set} disabled={!editable} />
      {editable && (
        <>
          {(s.error || problem) && <p className="text-sm text-amber-800">{s.error ?? problem}</p>}
          <div className="flex flex-wrap justify-between gap-2">
            <Button variant="ghost" className={branch.isActive ? 'text-red-700' : ''} loading={s.busy} onClick={() => setActive(!branch.isActive)}>
              {branch.isActive ? 'Close branch' : 'Reopen branch'}
            </Button>
            <Button onClick={save} loading={s.busy} disabled={!!problem}>
              Save details
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

function BillingSettings({ branchId, editable }: { branchId: string; editable: boolean }) {
  const settings = useQuery({ queryKey: ['branch-settings', branchId], queryFn: () => api.get<Settings>(`/branches/${branchId}/settings`) });
  if (settings.isError) return <ErrorNote message={errorMessage(settings.error)} onRetry={() => settings.refetch()} />;
  if (!settings.data) return <Spinner label="Loading settings" />;
  return <SettingsForm branchId={branchId} initial={settings.data} editable={editable} />;
}

function SettingsForm({ branchId, initial, editable }: { branchId: string; initial: Settings; editable: boolean }) {
  const qc = useQueryClient();
  const [f, setF] = useState<Settings>(() => ({ ...initial, serviceChargePercent: String(Number(initial.serviceChargePercent)), maxCashierDiscountPct: String(Number(initial.maxCashierDiscountPct)) }));
  const s = useSaver();
  const set = (p: Partial<Settings>) => setF((x) => ({ ...x, ...p }));
  const problem = !/^[A-Z0-9]{2,10}$/.test(f.invoicePrefix)
    ? 'Bill number prefix is 2 to 10 letters or digits'
    : !PERCENT.test(f.serviceChargePercent)
      ? 'Service charge is a percent between 0 and 100'
      : !PERCENT.test(f.maxCashierDiscountPct)
        ? 'Cashier discount limit is a percent between 0 and 100'
        : null;

  const save = () =>
    s.run(async () => {
      await api.patch(`/branches/${branchId}/settings`, {
        taxPricingMode: f.taxPricingMode,
        roundingMode: f.roundingMode,
        invoicePrefix: f.invoicePrefix,
        stockDeductionPolicy: f.stockDeductionPolicy,
        allowNegativeStock: f.allowNegativeStock,
        cashRequiresShift: f.cashRequiresShift,
        serviceChargePercent: f.serviceChargePercent,
        maxCashierDiscountPct: f.maxCashierDiscountPct,
      });
      await qc.invalidateQueries({ queryKey: ['branch-settings', branchId] });
    }, 'Billing settings saved');

  const d = !editable;
  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="font-semibold">Billing</h2>
      <Select label="Menu prices" value={f.taxPricingMode} disabled={d} onChange={(e) => set({ taxPricingMode: e.target.value as Settings['taxPricingMode'] })}>
        <option value="EXCLUSIVE">GST is added on top of menu prices</option>
        <option value="INCLUSIVE">Menu prices already include GST</option>
      </Select>
      <Select label="Round the bill to" value={f.roundingMode} disabled={d} onChange={(e) => set({ roundingMode: e.target.value as Settings['roundingMode'] })}>
        <option value="NEAREST_RUPEE">Nearest rupee</option>
        <option value="NEAREST_PAISA">Nearest paisa (no rounding)</option>
      </Select>
      <div className="grid grid-cols-3 gap-3">
        <Input label="Bill number prefix" value={f.invoicePrefix} maxLength={10} disabled={d} hint="Changing it starts a new series" onChange={(e) => set({ invoicePrefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} />
        <Input label="Service charge %" inputMode="decimal" value={f.serviceChargePercent} disabled={d} onChange={(e) => set({ serviceChargePercent: e.target.value.trim() })} />
        <Input label="Cashier discount limit %" inputMode="decimal" value={f.maxCashierDiscountPct} disabled={d} onChange={(e) => set({ maxCashierDiscountPct: e.target.value.trim() })} />
      </div>
      <Select label="Take ingredients out of stock" value={f.stockDeductionPolicy} disabled={d} onChange={(e) => set({ stockDeductionPolicy: e.target.value as Settings['stockDeductionPolicy'] })}>
        <option value="ON_ORDER_CONFIRM">When the order goes to the kitchen</option>
        <option value="ON_ORDER_COMPLETE">When the order is completed</option>
        <option value="NONE">Never (stock is not tracked from sales)</option>
      </Select>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={!f.allowNegativeStock} disabled={d} onChange={(e) => set({ allowNegativeStock: !e.target.checked })} />
        <span>Stop sending items to the kitchen when there is not enough stock</span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={f.cashRequiresShift} disabled={d} onChange={(e) => set({ cashRequiresShift: e.target.checked })} />
        <span>Cashiers must open a cash drawer shift before taking cash</span>
      </label>
      {editable && (
        <>
          {(s.error || problem) && <p className="text-sm text-amber-800">{s.error ?? problem}</p>}
          <div className="flex justify-end">
            <Button onClick={save} loading={s.busy} disabled={!!problem}>
              Save billing settings
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

function Stations({ branchId, editable }: { branchId: string; editable: boolean }) {
  const qc = useQueryClient();
  const stations = useQuery({ queryKey: ['stations', branchId], queryFn: () => api.get<KitchenStation[]>(`/branches/${branchId}/kitchen-stations`) });
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const s = useSaver();
  const refresh = () => qc.invalidateQueries({ queryKey: ['stations', branchId] });
  const problem = code && !/^[A-Z0-9_-]{2,20}$/.test(code) ? 'Short code is 2 to 20 letters or digits' : null;

  const add = async () => {
    const ok = await s.run(async () => {
      await api.post(`/branches/${branchId}/kitchen-stations`, { code, name: name.trim() });
      await refresh();
    }, `${name.trim()} added`);
    if (ok) {
      setCode('');
      setName('');
    }
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div>
        <h2 className="font-semibold">Kitchen stations</h2>
        <p className="text-sm text-stone-500">Each dish is sent to one station, which has its own screen in the kitchen.</p>
      </div>
      {stations.isError ? (
        <ErrorNote message={errorMessage(stations.error)} onRetry={() => stations.refetch()} />
      ) : !stations.data ? (
        <Spinner />
      ) : (
        <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200">
          {stations.data.length === 0 && <li className="px-3 py-2 text-sm text-stone-500">No stations yet</li>}
          {stations.data.map((st) => (
            <li key={st.id} className="flex items-center gap-3 px-3 py-2">
              <span className={cn('flex-1', !st.isActive && 'text-stone-400')}>
                <span className="font-medium">{st.name}</span> <span className="text-xs text-stone-500">{st.code}</span>
              </span>
              {!st.isActive && <Badge tone="red">Off</Badge>}
              {editable && (
                <Button size="sm" variant="ghost" onClick={() => s.run(async () => (await api.patch(`/branches/${branchId}/kitchen-stations/${st.id}`, { isActive: !st.isActive }), await refresh()), st.isActive ? `${st.name} turned off` : `${st.name} turned on`)}>
                  {st.isActive ? 'Turn off' : 'Turn on'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] items-end gap-2">
            <Input label="Short code" placeholder="BEV" maxLength={20} value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/\s/g, ''))} />
            <Input label="Station name" placeholder="Beverage counter" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
            <Button variant="secondary" className="h-11" onClick={add} loading={s.busy} disabled={!code || name.trim().length < 2 || !!problem}>
              Add
            </Button>
          </div>
          {(s.error || problem) && <p className="text-sm text-amber-800">{s.error ?? problem}</p>}
        </>
      )}
    </Card>
  );
}

function NewBranch({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [code, setCode] = useState('');
  const [f, setF] = useState(() => toForm());
  const s = useSaver();
  const problem = !/^[A-Z0-9-]{2,20}$/.test(code) ? 'Branch code is 2 to 20 letters, digits or -' : detailsProblem(f);

  const create = async () => {
    let id = '';
    const ok = await s.run(async () => {
      const b = await api.post<BranchFull>('/branches', { code, ...payload(f) });
      id = b.id;
    }, 'Branch created');
    if (ok) onCreated(id);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="New branch"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={create} loading={s.busy} disabled={!!problem}>
            Create branch
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Input label="Branch code" placeholder="BLR-HSR" maxLength={20} hint="Short and unique, used on reports" value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))} />
        <DetailsFields f={f} set={(p) => setF((x) => ({ ...x, ...p }))} />
        {(s.error || (code && problem)) && <p className="text-sm text-amber-800">{s.error ?? problem}</p>}
      </div>
    </Dialog>
  );
}
