'use client';

import { Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import { skuFrom } from '@/lib/format';
import type { AdminCategory, AdminProduct, KitchenStation, ModifierGroup, TaxRate } from '@/lib/types';
import { Button, Dialog, ErrorNote, Input, Select } from './ui';

const MONEY = /^\d{1,8}(\.\d{1,2})?$/;

interface VariantRow {
  id?: string;
  name: string;
  price: string;
  isDefault: boolean;
  isActive: boolean;
}

interface Props {
  productId: string | null; // null = new dish
  categoryId?: string;
  categories: AdminCategory[];
  taxRates: TaxRate[];
  stations: KitchenStation[];
  groups: ModifierGroup[];
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Create or edit one dish: details, sizes and add-on groups. Each part is saved with its own API call;
 * prices are sent exactly as typed (two decimals at most) and only by people allowed to change prices.
 */
export function ProductEditor({ productId, categoryId, categories, taxRates, stations, groups, onClose, onSaved }: Props) {
  const { can } = useSession();
  const canPrice = can('menu.price.update', null);
  const [loading, setLoading] = useState(!!productId);
  const [original, setOriginal] = useState<AdminProduct | null>(null);
  const [f, setF] = useState({
    name: '',
    categoryId: categoryId ?? categories[0]?.id ?? '',
    sku: '',
    basePrice: '',
    taxRateId: taxRates.find((t) => t.rate === '5')?.id ?? taxRates[0]?.id ?? '',
    hsnSac: '996331',
    isVeg: true,
    stationCode: stations[0]?.code ?? '',
    description: '',
    isActive: true,
  });
  const [variants, setVariants] = useState<VariantRow[]>([]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!productId) return;
    let cancelled = false;
    api
      .get<AdminProduct>(`/menu/products/${productId}`)
      .then((p) => {
        if (cancelled) return;
        setOriginal(p);
        setF({
          name: p.name,
          categoryId: p.categoryId,
          sku: p.sku ?? '',
          basePrice: p.basePrice,
          taxRateId: p.taxRateId ?? '',
          hsnSac: p.hsnSac ?? '',
          isVeg: p.isVeg,
          stationCode: p.stationCode ?? '',
          description: p.description ?? '',
          isActive: p.isActive,
        });
        setVariants(p.variants.map((v) => ({ id: v.id, name: v.name, price: v.price, isDefault: v.isDefault, isActive: v.isActive })));
        setGroupIds((p.modifierGroups ?? []).map((g) => g.groupId));
      })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [productId]);

  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const activeVariants = variants.filter((v) => v.isActive);
  const problems: string[] = [];
  if (!f.name.trim()) problems.push('Enter the dish name');
  if (!f.categoryId) problems.push('Choose a category');
  if (!MONEY.test(f.basePrice)) problems.push('Enter the price, like 250 or 249.50');
  if (f.sku && !/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(f.sku)) problems.push('Code: capital letters, digits, - or _ only');
  if (!f.sku && f.name.trim() && !skuFrom(f.name)) problems.push('Enter a code for this dish, using A–Z and 0–9');
  if (f.hsnSac && !/^[0-9]{4,8}$/.test(f.hsnSac)) problems.push('HSN/SAC must be 4 to 8 digits');
  for (const v of activeVariants) {
    if (!v.name.trim()) problems.push('Every size needs a name');
    if (!MONEY.test(v.price)) problems.push(`Enter a price for ${v.name || 'each size'}`);
  }
  if (activeVariants.length && activeVariants.filter((v) => v.isDefault).length !== 1) problems.push('Mark one size as the default');

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const details = {
        name: f.name.trim(),
        categoryId: f.categoryId,
        sku: f.sku || skuFrom(f.name),
        taxRateId: f.taxRateId || undefined,
        hsnSac: f.hsnSac || undefined,
        isVeg: f.isVeg,
        stationCode: f.stationCode || undefined,
        description: f.description.trim() || undefined,
      };
      let id = productId;
      if (!id) {
        const created = await api.post<AdminProduct>('/menu/products', {
          ...details,
          basePrice: f.basePrice,
          variants: activeVariants.map((v, i) => ({ name: v.name.trim(), price: v.price, isDefault: v.isDefault, sortOrder: i })),
          modifierGroupIds: groupIds,
        });
        id = created.id;
      } else {
        const o = original!;
        await api.patch(`/menu/products/${id}`, {
          ...details,
          isActive: f.isActive,
          ...(canPrice && f.basePrice !== o.basePrice ? { basePrice: f.basePrice } : {}),
        });
        // Sizes: new ones are added; changed ones patched. Removing a size hides it (orders keep their history).
        for (const [i, v] of variants.entries()) {
          const before = o.variants.find((x) => x.id === v.id);
          if (!v.id) {
            if (v.isActive) await api.post(`/menu/products/${id}/variants`, { name: v.name.trim(), price: v.price, isDefault: v.isDefault, sortOrder: i });
            continue;
          }
          if (!before) continue;
          const patch: Record<string, unknown> = {};
          if (v.name.trim() !== before.name) patch.name = v.name.trim();
          if (v.isDefault !== before.isDefault && v.isDefault) patch.isDefault = true;
          if (v.isActive !== before.isActive) patch.isActive = v.isActive;
          if (canPrice && v.price !== before.price) patch.price = v.price;
          if (Object.keys(patch).length) await api.patch(`/menu/products/${id}/variants/${v.id}`, patch);
        }
        const beforeGroups = (o.modifierGroups ?? []).map((g) => g.groupId);
        if (beforeGroups.join() !== groupIds.join()) await api.put(`/menu/products/${id}/modifier-groups`, { groupIds });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'DUPLICATE_NAME' ? 'Another dish already has this name or code.' : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const priceLocked = !!productId && !canPrice;

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={productId ? `Edit ${original?.name ?? 'dish'}` : 'New dish'}
      footer={
        <>
          {problems.length > 0 && !loading && <span className="mr-auto self-center text-sm text-amber-800">{problems[0]}</span>}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={loading || problems.length > 0}>
            {productId ? 'Save changes' : 'Add dish'}
          </Button>
        </>
      }
    >
      {loading ? (
        <p className="text-sm text-stone-500">Loading…</p>
      ) : (
        <div className="flex flex-col gap-5">
          {error && <ErrorNote message={error} />}
          <div className="grid gap-3 sm:grid-cols-2">
            <Input ref={first} label="Dish name" value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={120} autoFocus />
            <Select label="Category" value={f.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <Input
              label="Price (₹)"
              inputMode="decimal"
              value={f.basePrice}
              onChange={(e) => set('basePrice', e.target.value.trim())}
              disabled={priceLocked}
              hint={priceLocked ? 'Only the owner can change prices' : activeVariants.length ? 'Used when no size is chosen' : undefined}
            />
            <Select label="GST rate" value={f.taxRateId} onChange={(e) => set('taxRateId', e.target.value)}>
              {taxRates
                .filter((t) => t.isActive)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </Select>
            <Select label="Cooked at" value={f.stationCode} onChange={(e) => set('stationCode', e.target.value)}>
              <option value="">Any station</option>
              {stations.map((s) => (
                <option key={s.id} value={s.code}>
                  {s.name}
                </option>
              ))}
            </Select>
            <div className="grid grid-cols-2 gap-3">
              <Input label="Code (optional)" hint={f.sku ? undefined : `Will be ${skuFrom(f.name) || 'made from the name'}`} value={f.sku} onChange={(e) => set('sku', e.target.value.toUpperCase())} maxLength={40} />
              <Input label="HSN/SAC" inputMode="numeric" value={f.hsnSac} onChange={(e) => set('hsnSac', e.target.value.trim())} maxLength={8} />
            </div>
          </div>
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-5" checked={f.isVeg} onChange={(e) => set('isVeg', e.target.checked)} /> Vegetarian
            </label>
            {productId && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="size-5" checked={f.isActive} onChange={(e) => set('isActive', e.target.checked)} /> On the menu
              </label>
            )}
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-semibold">Sizes</legend>
            {variants.length === 0 && <p className="text-sm text-stone-500">One size only. Add sizes such as Half and Full if the dish comes in more than one.</p>}
            {variants.map((v, i) =>
              v.isActive ? (
                <div key={v.id ?? `new-${i}`} className="grid grid-cols-[1fr_8rem_auto_auto] items-end gap-2">
                  <Input label="Size" value={v.name} onChange={(e) => setVariants((vs) => vs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} maxLength={40} />
                  <Input
                    label="Price (₹)"
                    inputMode="decimal"
                    value={v.price}
                    disabled={!!v.id && priceLocked}
                    onChange={(e) => setVariants((vs) => vs.map((x, j) => (j === i ? { ...x, price: e.target.value.trim() } : x)))}
                  />
                  <label className="flex h-11 items-center gap-1.5 text-sm">
                    <input type="radio" name="default-size" checked={v.isDefault} onChange={() => setVariants((vs) => vs.map((x, j) => ({ ...x, isDefault: j === i })))} /> Default
                  </label>
                  <Button variant="ghost" className="h-11" onClick={() => setVariants((vs) => (v.id ? vs.map((x, j) => (j === i ? { ...x, isActive: false, isDefault: false } : x)) : vs.filter((_, j) => j !== i)))}>
                    Remove
                  </Button>
                </div>
              ) : null,
            )}
            <Button
              variant="secondary"
              size="sm"
              className="self-start"
              disabled={priceLocked}
              onClick={() => setVariants((vs) => [...vs, { name: '', price: '', isDefault: !vs.some((x) => x.isActive), isActive: true }])}
            >
              <Plus className="size-4" aria-hidden /> Add size
            </Button>
          </fieldset>

          <fieldset>
            <legend className="mb-2 text-sm font-semibold">Add-on groups</legend>
            {groups.length === 0 ? (
              <p className="text-sm text-stone-500">No add-on groups yet. Create them under Add-ons on the menu screen.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {groups.map((g) => (
                  <label key={g.id} className="flex items-center gap-2 rounded-lg border border-stone-300 px-3 py-2 text-sm">
                    <input type="checkbox" checked={groupIds.includes(g.id)} onChange={(e) => setGroupIds((ids) => (e.target.checked ? [...ids, g.id] : ids.filter((x) => x !== g.id)))} />
                    {g.name}
                    <span className="text-stone-500">({g.modifiers.filter((m) => m.isActive).length})</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          <Input label="Description (optional)" value={f.description} onChange={(e) => set('description', e.target.value)} maxLength={1000} />
        </div>
      )}
    </Dialog>
  );
}

