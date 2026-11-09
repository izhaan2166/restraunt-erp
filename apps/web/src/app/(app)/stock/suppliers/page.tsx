'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useToast } from '@/components/toast';
import { Badge, Button, Card, Dialog, Empty, ErrorNote, Input, PageHeader, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { Supplier } from '@/lib/types';

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PHONE = /^\+?[0-9]{10,15}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** People the restaurant buys from. Shared by every branch. */
export default function SuppliersPage() {
  const { can } = useSession();
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Supplier | 'new' | null>(null);
  const suppliers = useQuery({ queryKey: ['suppliers'], queryFn: () => api.all<Supplier>('/suppliers', { includeInactive: true }) });

  if (suppliers.isError) return <ErrorNote message={errorMessage(suppliers.error)} onRetry={() => suppliers.refetch()} />;
  if (!suppliers.data) return <Spinner label="Loading suppliers" />;
  const q = search.trim().toLowerCase();
  const shown = suppliers.data.filter((s) => (showInactive || s.isActive) && (!q || s.name.toLowerCase().includes(q) || (s.phone ?? '').includes(q)));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Suppliers"
        subtitle="Who you buy from, shared by all branches."
        actions={
          can('suppliers.manage') && (
            <Button onClick={() => setEditing('new')}>
              <Plus className="size-4" aria-hidden /> Add supplier
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <input type="search" aria-label="Search suppliers" placeholder="Name or phone" value={search} onChange={(e) => setSearch(e.target.value)} className="h-10 min-w-0 flex-1 rounded-lg border border-stone-300 px-3" />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive
        </label>
      </div>
      {shown.length === 0 ? (
        <Empty title="No suppliers yet" />
      ) : (
        <Card>
          <ul className="divide-y divide-stone-100">
            {shown.map((s) => (
              <li key={s.id}>
                <button className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-stone-50" onClick={() => setEditing(s)} data-testid="supplier-row">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {s.name} {!s.isActive && <Badge tone="red">Inactive</Badge>}
                    </p>
                    <p className="truncate text-xs text-stone-500">{[s.contactPerson, s.phone, s.gstin && `GSTIN ${s.gstin}`].filter(Boolean).join(' · ') || 'No contact details'}</p>
                  </div>
                  {s.paymentTermsDays ? <Badge>Pay in {s.paymentTermsDays} days</Badge> : <Badge>Pay on delivery</Badge>}
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {editing && <SupplierDialog supplier={editing === 'new' ? null : editing} editable={can('suppliers.manage')} onClose={() => setEditing(null)} />}
    </div>
  );
}

function SupplierDialog({ supplier, editable, onClose }: { supplier: Supplier | null; editable: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({
    name: supplier?.name ?? '',
    contactPerson: supplier?.contactPerson ?? '',
    phone: supplier?.phone ?? '',
    email: supplier?.email ?? '',
    gstin: supplier?.gstin ?? '',
    address: supplier?.address ?? '',
    paymentTermsDays: String(supplier?.paymentTermsDays ?? 0),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));

  const problem =
    f.name.trim().length < 2
      ? 'Enter the supplier name'
      : f.phone && !PHONE.test(f.phone)
        ? 'Phone number should be 10 to 15 digits'
        : f.email && !EMAIL.test(f.email)
          ? 'That email does not look right'
          : f.gstin && !GSTIN.test(f.gstin)
            ? 'That GSTIN does not look right'
            : !/^\d{1,3}$/.test(f.paymentTermsDays) || Number(f.paymentTermsDays) > 365
              ? 'Payment terms are 0 to 365 days'
              : null;

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['suppliers'] });
      toast(done, 'success');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const body = {
    name: f.name.trim(),
    contactPerson: f.contactPerson.trim() || undefined,
    phone: f.phone || undefined,
    email: f.email.trim() || undefined,
    gstin: f.gstin || undefined,
    // The GSTIN starts with the supplier's state, which decides CGST+SGST or IGST on their bills.
    stateCode: f.gstin ? f.gstin.slice(0, 2) : undefined,
    address: f.address.trim() || undefined,
    paymentTermsDays: Number(f.paymentTermsDays),
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={supplier ? supplier.name : 'Add supplier'}
      footer={
        <>
          {supplier && editable && (
            <Button variant="ghost" className="mr-auto" loading={busy} onClick={() => run(() => api.patch(`/suppliers/${supplier.id}`, { isActive: !supplier.isActive }), supplier.isActive ? `${supplier.name} marked inactive` : `${supplier.name} is active again`)}>
              {supplier.isActive ? 'Mark inactive' : 'Make active'}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            {editable ? 'Cancel' : 'Close'}
          </Button>
          {editable && (
            <Button loading={busy} disabled={!!problem} onClick={() => run(() => (supplier ? api.patch(`/suppliers/${supplier.id}`, body) : api.post('/suppliers', body)), supplier ? 'Supplier saved' : `${body.name} added`)}>
              {supplier ? 'Save' : 'Add supplier'}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <ErrorNote message={error} />}
        <Input label="Name" value={f.name} maxLength={120} disabled={!editable} onChange={(e) => set({ name: e.target.value })} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Contact person (optional)" value={f.contactPerson} maxLength={80} disabled={!editable} onChange={(e) => set({ contactPerson: e.target.value })} />
          <Input label="Phone (optional)" type="tel" value={f.phone} maxLength={16} disabled={!editable} onChange={(e) => set({ phone: e.target.value.replace(/[^\d+]/g, '') })} />
          <Input label="Email (optional)" type="email" value={f.email} maxLength={120} disabled={!editable} onChange={(e) => set({ email: e.target.value.trim() })} />
          <Input label="GSTIN (optional)" value={f.gstin} maxLength={15} disabled={!editable} onChange={(e) => set({ gstin: e.target.value.toUpperCase().replace(/\s/g, '') })} />
        </div>
        <Input label="Address (optional)" value={f.address} maxLength={500} disabled={!editable} onChange={(e) => set({ address: e.target.value })} />
        <Input label="Pay within (days)" inputMode="numeric" value={f.paymentTermsDays} disabled={!editable} hint="0 means pay on delivery" onChange={(e) => set({ paymentTermsDays: e.target.value.replace(/\D/g, '') })} />
        {editable && problem && f.name && <p className="text-sm text-amber-800">{problem}</p>}
      </div>
    </Dialog>
  );
}
