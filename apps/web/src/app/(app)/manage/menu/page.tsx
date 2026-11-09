'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ProductEditor } from '@/components/product-editor';
import { useToast } from '@/components/toast';
import { Badge, Button, Card, Dialog, Empty, ErrorNote, Input, PageHeader, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { rupees } from '@/lib/format';
import { useBranch, useSession } from '@/lib/session';
import type { AdminCategory, AdminProduct, KitchenStation, ModifierGroup, PosMenu, TaxRate } from '@/lib/types';

const MONEY = /^\d{1,8}(\.\d{1,2})?$/;

/**
 * The menu: categories, dishes and add-on groups for the whole organisation, plus "available today"
 * for the selected branch. Kitchen staff only see the availability switches.
 */
export default function MenuAdminPage() {
  const branch = useBranch();
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const canManage = can('menu.manage', null);
  const canAvailability = can('menu.availability.update');
  const [category, setCategory] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [tab, setTab] = useState<'dishes' | 'addons'>('dishes');

  const categories = useQuery({ queryKey: ['admin-categories'], queryFn: () => api.get<AdminCategory[]>('/menu/categories') });
  const products = useQuery({ queryKey: ['admin-products'], queryFn: () => api.all<AdminProduct>('/menu/products') });
  const live = useQuery({ queryKey: ['menu', branch.id], queryFn: () => api.get<PosMenu>('/menu', { branchId: branch.id }) });
  const groups = useQuery({ queryKey: ['modifier-groups'], queryFn: () => api.get<ModifierGroup[]>('/menu/modifier-groups'), enabled: canManage });
  const taxRates = useQuery({ queryKey: ['tax-rates'], queryFn: () => api.get<TaxRate[]>('/tax-rates'), enabled: canManage });
  const stations = useQuery({ queryKey: ['stations', branch.id], queryFn: () => api.get<KitchenStation[]>(`/branches/${branch.id}/kitchen-stations`), enabled: canManage });

  const availableHere = useMemo(() => new Map((live.data?.products ?? []).map((p) => [p.id, p.isAvailable])), [live.data]);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin-products'] });
    qc.invalidateQueries({ queryKey: ['admin-categories'] });
    qc.invalidateQueries({ queryKey: ['menu'] });
    qc.invalidateQueries({ queryKey: ['modifier-groups'] });
  };

  // The switch flips at once; it settles to what the server says once the menu reloads.
  const [flipping, setFlipping] = useState<Record<string, boolean>>({});
  async function setAvailable(p: AdminProduct, isAvailable: boolean) {
    setFlipping((m) => ({ ...m, [p.id]: isAvailable }));
    try {
      await api.patch(`/menu/products/${p.id}/availability`, { branchId: branch.id, isAvailable });
      toast(isAvailable ? `${p.name} is back on` : `${p.name} marked sold out in ${branch.name}`, 'success');
      await qc.invalidateQueries({ queryKey: ['menu', branch.id] });
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setFlipping(({ [p.id]: _, ...rest }) => rest);
    }
  }

  const error = categories.error ?? products.error ?? live.error;
  if (error) return <ErrorNote message={errorMessage(error)} onRetry={refresh} />;
  if (!categories.data || !products.data || !live.data) return <Spinner label="Loading menu" />;
  const cats = categories.data;

  const q = search.trim().toLowerCase();
  const shown = products.data.filter((p) => (q ? p.name.toLowerCase().includes(q) || p.sku?.toLowerCase().includes(q) : !category || p.categoryId === category));
  const editorReady = canManage && groups.data && taxRates.data && stations.data;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Menu"
        subtitle={canManage ? 'Dishes and prices are the same in every branch. "Available" is for this branch only.' : `Mark dishes sold out in ${branch.name}.`}
        actions={
          canManage &&
          can('menu.price.update', null) && (
            <Button onClick={() => setEditing('new')} disabled={!editorReady || !cats.length}>
              <Plus className="size-4" aria-hidden /> New dish
            </Button>
          )
        }
      />
      {canManage && (
        <div role="tablist" aria-label="Menu section" className="flex w-fit gap-1 rounded-lg bg-stone-100 p-1 text-sm">
          {(['dishes', 'addons'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cn('h-8 rounded-md px-3 font-medium', tab === t ? 'bg-white shadow-sm' : 'text-stone-600')}>
              {t === 'dishes' ? 'Dishes' : 'Add-ons'}
            </button>
          ))}
        </div>
      )}

      {tab === 'addons' && canManage ? (
        <AddonGroups groups={groups.data} loading={groups.isPending} onChanged={refresh} />
      ) : (
        <div className="grid gap-4 md:grid-cols-[14rem_minmax(0,1fr)]">
          <Categories categories={cats} selected={category} onSelect={(id) => (setCategory(id), setSearch(''))} canManage={canManage} onChanged={refresh} />
          <div className="flex min-w-0 flex-col gap-3">
            <input
              type="search"
              aria-label="Search dishes"
              placeholder="Search by name or code"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-10 rounded-lg border border-stone-300 px-3"
            />
            {shown.length === 0 ? (
              <Empty title="No dishes here" />
            ) : (
              <Card>
                <ul className="divide-y divide-stone-100">
                  {shown.map((p) => {
                    const avail = flipping[p.id] ?? availableHere.get(p.id);
                    return (
                      <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="admin-product">
                        <span className={cn('size-3 shrink-0 rounded-sm border-2', p.isVeg ? 'border-emerald-600' : 'border-red-600')} role="img" aria-label={p.isVeg ? 'Veg' : 'Non-veg'} />
                        <div className="min-w-0 flex-1">
                          <p className="font-medium">
                            {p.name} {!p.isActive && <Badge>Hidden</Badge>}
                          </p>
                          <p className="text-xs text-stone-500">
                            {p.category.name}
                            {p.sku ? ` · ${p.sku}` : ''}
                            {p.variants.filter((v) => v.isActive).length > 0
                              ? ` · ${p.variants
                                  .filter((v) => v.isActive)
                                  .map((v) => `${v.name} ${rupees(v.price)}`)
                                  .join(', ')}`
                              : ` · ${rupees(p.basePrice)}`}
                          </p>
                        </div>
                        {p.isActive && canAvailability && avail !== undefined && (
                          <label className="flex items-center gap-2 text-sm">
                            <input type="checkbox" role="switch" className="size-5 accent-emerald-600" checked={avail} disabled={p.id in flipping} onChange={(e) => setAvailable(p, e.target.checked)} aria-label={`${p.name} available in ${branch.name}`} />
                            {avail ? 'Available' : <span className="font-medium text-red-700">Sold out</span>}
                          </label>
                        )}
                        {canManage && (
                          <Button size="sm" variant="secondary" onClick={() => setEditing(p.id)} disabled={!editorReady} aria-label={`Edit ${p.name}`}>
                            <Pencil className="size-4" aria-hidden /> Edit
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </Card>
            )}
          </div>
        </div>
      )}

      {editing && editorReady && (
        <ProductEditor
          productId={editing === 'new' ? null : editing}
          categoryId={category ?? undefined}
          categories={cats.filter((c) => c.isActive)}
          taxRates={taxRates.data}
          stations={stations.data.filter((s) => s.isActive)}
          groups={groups.data}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            toast('Menu saved', 'success');
            refresh();
          }}
        />
      )}
    </div>
  );
}

function Categories({ categories, selected, onSelect, canManage, onChanged }: { categories: AdminCategory[]; selected: string | null; onSelect: (id: string | null) => void; canManage: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [edit, setEdit] = useState<AdminCategory | 'new' | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      if (edit === 'new') await api.post('/menu/categories', { name: name.trim(), sortOrder: categories.length });
      else if (edit) await api.patch(`/menu/categories/${edit.id}`, { name: name.trim() });
      setEdit(null);
      onChanged();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }
  async function toggle(c: AdminCategory) {
    try {
      await api.patch(`/menu/categories/${c.id}`, { isActive: !c.isActive });
      onChanged();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  return (
    <aside aria-label="Categories" className="flex flex-col gap-1">
      <div className="flex gap-1 overflow-x-auto md:flex-col">
        {[{ id: null as string | null, name: 'All dishes', isActive: true, _count: { products: categories.reduce((n, c) => n + c._count.products, 0) } }, ...categories].map((c) => (
          <div key={c.id ?? 'all'} className="group flex shrink-0 items-center">
            <button
              onClick={() => onSelect(c.id)}
              aria-pressed={selected === c.id}
              className={cn('flex flex-1 items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm', selected === c.id ? 'bg-brand-50 font-medium text-brand-800' : 'hover:bg-stone-100', !c.isActive && 'text-stone-400')}
            >
              <span>{c.name}</span>
              <span className="text-xs text-stone-500">{c._count.products}</span>
            </button>
            {canManage && c.id && (
              <button
                className="rounded p-1.5 text-stone-400 hover:bg-stone-100 hover:text-stone-700"
                aria-label={`Rename ${c.name}`}
                onClick={() => {
                  setEdit(c as AdminCategory);
                  setName(c.name);
                }}
              >
                <Pencil className="size-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>
      {canManage && (
        <Button
          variant="ghost"
          size="sm"
          className="justify-start"
          onClick={() => {
            setEdit('new');
            setName('');
          }}
        >
          <Plus className="size-4" aria-hidden /> Add category
        </Button>
      )}
      {edit && (
        <Dialog
          open
          onClose={() => setEdit(null)}
          title={edit === 'new' ? 'New category' : `Category: ${edit.name}`}
          footer={
            <>
              {edit !== 'new' && (
                <Button variant="ghost" className="mr-auto" onClick={() => (toggle(edit), setEdit(null))}>
                  {edit.isActive ? 'Hide from menu' : 'Show on menu'}
                </Button>
              )}
              <Button variant="ghost" onClick={() => setEdit(null)}>
                Cancel
              </Button>
              <Button onClick={save} loading={busy} disabled={!name.trim()}>
                Save
              </Button>
            </>
          }
        >
          <Input label="Category name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />
        </Dialog>
      )}
    </aside>
  );
}

function AddonGroups({ groups, loading, onChanged }: { groups?: ModifierGroup[]; loading: boolean; onChanged: () => void }) {
  const toast = useToast();
  const { can } = useSession();
  const canPrice = can('menu.price.update', null);
  const [edit, setEdit] = useState<ModifierGroup | 'new' | null>(null);
  if (loading || !groups) return <Spinner />;

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      if (done) toast(done, 'success');
      onChanged();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-stone-600">Add-on groups are choices offered with a dish, such as extra cheese or a choice of bread. Attach them to dishes in each dish&apos;s editor.</p>
      {groups.length === 0 && <Empty title="No add-on groups yet" />}
      {groups.map((g) => (
        <Card key={g.id} className="p-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div>
              <h3 className="font-semibold">{g.name}</h3>
              <p className="text-xs text-stone-500">
                {g.minSelect > 0 ? `Required, at least ${g.minSelect}` : 'Optional'} · up to {g.maxSelect}
              </p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => setEdit(g)}>
              Edit rules
            </Button>
          </div>
          <ul className="divide-y divide-stone-100">
            {g.modifiers.map((m) => (
              <ModifierRow key={m.id} groupId={g.id} m={m} canPrice={canPrice} run={run} />
            ))}
          </ul>
          <NewModifier groupId={g.id} disabled={!canPrice} run={run} />
        </Card>
      ))}
      <Button variant="secondary" className="self-start" onClick={() => setEdit('new')} disabled={!canPrice}>
        <Plus className="size-4" aria-hidden /> New add-on group
      </Button>
      {edit && <GroupDialog group={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), onChanged())} />}
    </div>
  );
}

function ModifierRow({ groupId, m, canPrice, run }: { groupId: string; m: ModifierGroup['modifiers'][number]; canPrice: boolean; run: (fn: () => Promise<unknown>, done?: string) => Promise<void> }) {
  const [price, setPrice] = useState(m.price);
  const changed = price !== m.price;
  return (
    <li className={cn('flex flex-wrap items-center gap-3 py-2', !m.isActive && 'text-stone-400')}>
      <span className="flex-1">{m.name}</span>
      <label className="flex items-center gap-1 text-sm">
        <span className="sr-only">Price of {m.name}</span>₹
        <input
          className="h-9 w-24 rounded-md border border-stone-300 px-2 tabular-nums disabled:bg-stone-50"
          inputMode="decimal"
          value={price}
          disabled={!canPrice}
          onChange={(e) => setPrice(e.target.value.trim())}
        />
      </label>
      {changed && (
        <Button size="sm" disabled={!MONEY.test(price)} onClick={() => run(() => api.patch(`/menu/modifier-groups/${groupId}/modifiers/${m.id}`, { price }), `${m.name} price saved`)}>
          Save
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={() => run(() => api.patch(`/menu/modifier-groups/${groupId}/modifiers/${m.id}`, { isActive: !m.isActive }))}>
        {m.isActive ? 'Hide' : 'Show'}
      </Button>
    </li>
  );
}

function NewModifier({ groupId, disabled, run }: { groupId: string; disabled: boolean; run: (fn: () => Promise<unknown>, done?: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  return (
    <form
      className="mt-2 flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        await run(() => api.post(`/menu/modifier-groups/${groupId}/modifiers`, { name: name.trim(), price }), `${name.trim()} added`);
        setName('');
        setPrice('');
      }}
    >
      <div className="min-w-40 flex-1">
        <Input label="New add-on" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} disabled={disabled} />
      </div>
      <div className="w-28">
        <Input label="Price (₹)" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value.trim())} disabled={disabled} />
      </div>
      <Button type="submit" variant="secondary" className="h-11" disabled={disabled || !name.trim() || !MONEY.test(price)}>
        Add
      </Button>
    </form>
  );
}

function GroupDialog({ group, onClose, onSaved }: { group: ModifierGroup | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(group?.name ?? '');
  const [min, setMin] = useState(String(group?.minSelect ?? 0));
  const [max, setMax] = useState(String(group?.maxSelect ?? 1));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = name.trim() && Number(min) >= 0 && Number(max) >= 1 && Number(min) <= Number(max);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), minSelect: Number(min), maxSelect: Number(max) };
      if (group) await api.patch(`/menu/modifier-groups/${group.id}`, body);
      else await api.post('/menu/modifier-groups', body);
      onSaved();
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
      title={group ? `Edit ${group.name}` : 'New add-on group'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={!valid}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <ErrorNote message={error} />}
        <Input label="Group name" placeholder="Choice of bread" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Must choose at least" type="number" min={0} max={20} value={min} onChange={(e) => setMin(e.target.value)} hint="0 = optional" />
          <Input label="Can choose up to" type="number" min={1} max={20} value={max} onChange={(e) => setMax(e.target.value)} />
        </div>
      </div>
    </Dialog>
  );
}
