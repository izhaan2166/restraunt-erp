'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useToast } from '@/components/toast';
import { Button, Card, Empty, ErrorNote, Input, PageHeader, Select, Spinner } from '@/components/ui';
import { ApiError, api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { rupees, stockQty } from '@/lib/format';
import { useBranch, useSession } from '@/lib/session';
import type { AdminProduct, Ingredient, Recipe, Unit } from '@/lib/types';

const QTY = /^(0|[1-9][0-9]{0,10})(\.[0-9]{1,3})?$/;
const PCT = /^(100(\.0{1,3})?|[0-9]{1,2}(\.[0-9]{1,3})?)$/;

interface LineForm {
  ingredientId: string;
  quantity: string;
  unit: string;
  wastagePercent: string;
}

/** What goes into one portion of each dish. Every sale takes these amounts out of stock. */
export default function RecipesPage() {
  const [search, setSearch] = useState('');
  const [productId, setProductId] = useState<string | null>(null);
  const products = useQuery({ queryKey: ['admin-products'], queryFn: () => api.all<AdminProduct>('/menu/products') });
  const ingredients = useQuery({ queryKey: ['ingredients'], queryFn: () => api.all<Ingredient>('/ingredients', { includeInactive: true }) });
  const units = useQuery({ queryKey: ['units'], queryFn: () => api.get<Unit[]>('/units'), staleTime: Infinity });

  const error = products.error ?? ingredients.error ?? units.error;
  if (error) return <ErrorNote message={errorMessage(error)} onRetry={() => (products.refetch(), ingredients.refetch(), units.refetch())} />;
  if (!products.data || !ingredients.data || !units.data) return <Spinner label="Loading recipes" />;

  const q = search.trim().toLowerCase();
  const list = products.data.filter((p) => p.isActive && !p.isCombo && (!q || p.name.toLowerCase().includes(q)));
  const product = products.data.find((p) => p.id === productId);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Recipes" subtitle="What one portion uses. Sales take these amounts out of stock, and food cost reports use them." />
      <div className="grid gap-4 md:grid-cols-[18rem_minmax(0,1fr)]">
        <div className="flex flex-col gap-2">
          <input type="search" aria-label="Search dishes" placeholder="Search dishes" value={search} onChange={(e) => setSearch(e.target.value)} className="h-10 rounded-lg border border-stone-300 px-3" />
          <Card>
            <ul className="max-h-[60vh] divide-y divide-stone-100 overflow-y-auto" aria-label="Dishes">
              {list.map((p) => (
                <li key={p.id}>
                  <button onClick={() => setProductId(p.id)} aria-current={p.id === productId || undefined} className={cn('w-full px-3 py-2 text-left text-sm hover:bg-stone-50', p.id === productId && 'bg-brand-50 font-medium text-brand-800')}>
                    {p.name}
                    <span className="block text-xs text-stone-500">{p.category.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        </div>
        {product ? (
          <RecipeEditor key={product.id} product={product} ingredients={ingredients.data} units={units.data} />
        ) : (
          <Empty title="Choose a dish">Pick a dish on the left to see or set its recipe.</Empty>
        )}
      </div>
    </div>
  );
}

function RecipeEditor({ product, ingredients, units }: { product: AdminProduct; ingredients: Ingredient[]; units: Unit[] }) {
  const sizes = product.variants.filter((v) => v.isActive);
  const [variantId, setVariantId] = useState<string>('');
  return (
    <div className="flex flex-col gap-3">
      {sizes.length > 0 && (
        <Select label="Size" value={variantId} onChange={(e) => setVariantId(e.target.value)} className="max-w-xs">
          <option value="">Any size (used when a size has no recipe of its own)</option>
          {sizes.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </Select>
      )}
      <RecipeForm key={variantId} product={product} variantId={variantId || undefined} ingredients={ingredients} units={units} />
    </div>
  );
}

function RecipeForm({ product, variantId, ingredients, units }: { product: AdminProduct; variantId?: string; ingredients: Ingredient[]; units: Unit[] }) {
  const branch = useBranch();
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const editable = can('recipes.manage');
  const queryKey = ['recipe', product.id, variantId ?? '', branch.id];
  const recipe = useQuery({
    queryKey,
    queryFn: async () => {
      try {
        return await api.get<Recipe>(`/recipes/${product.id}`, { variantId, branchId: branch.id });
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
  });

  if (recipe.isError) return <ErrorNote message={errorMessage(recipe.error)} onRetry={() => recipe.refetch()} />;
  if (recipe.data === undefined) return <Spinner />;

  return (
    <LinesForm
      key={recipe.data?.updatedAt ?? 'none'}
      recipe={recipe.data}
      product={product}
      ingredients={ingredients}
      units={units}
      editable={editable}
      onSave={async (items) => {
        await api.put(`/recipes/${product.id}`, { variantId, items });
        await qc.invalidateQueries({ queryKey });
        toast(`Recipe for ${product.name} saved`, 'success');
      }}
      onDelete={async () => {
        await api.del(`/recipes/${product.id}${variantId ? `?variantId=${variantId}` : ''}`);
        await qc.invalidateQueries({ queryKey });
        toast(`Recipe for ${product.name} removed`, 'success');
      }}
    />
  );
}

function LinesForm({
  recipe,
  product,
  ingredients,
  units,
  editable,
  onSave,
  onDelete,
}: {
  recipe: Recipe | null;
  product: AdminProduct;
  ingredients: Ingredient[];
  units: Unit[];
  editable: boolean;
  onSave: (items: { ingredientId: string; quantity: string; unit: string; wastagePercent?: string }[]) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [lines, setLines] = useState<LineForm[]>(() => (recipe?.items ?? []).map((i) => ({ ingredientId: i.ingredientId, quantity: i.quantity, unit: i.unit, wastagePercent: String(Number(i.wastagePercent)) })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = ingredients.filter((i) => i.isActive);
  const byId = new Map(ingredients.map((i) => [i.id, i]));
  const costById = new Map((recipe?.items ?? []).map((i) => [i.ingredientId, i.estimatedCost]));
  const dirty = JSON.stringify(lines) !== JSON.stringify((recipe?.items ?? []).map((i) => ({ ingredientId: i.ingredientId, quantity: i.quantity, unit: i.unit, wastagePercent: String(Number(i.wastagePercent)) })));

  const problem = lines.some((l) => !l.ingredientId)
    ? 'Choose an ingredient on every line'
    : new Set(lines.map((l) => l.ingredientId)).size !== lines.length
      ? 'Each ingredient only once'
      : lines.some((l) => !QTY.test(l.quantity) || Number(l.quantity) <= 0)
        ? 'Enter how much of each ingredient one portion uses'
        : lines.some((l) => l.wastagePercent !== '' && !PCT.test(l.wastagePercent))
          ? 'Wastage is a percent between 0 and 100'
          : null;

  const update = (i: number, p: Partial<LineForm>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">{product.name}</h2>
        {recipe?.estimatedCostPerPortion && (
          <p className="text-sm text-stone-600">
            Ingredients cost about <span className="font-semibold">{rupees(recipe.estimatedCostPerPortion)}</span> a portion at today&apos;s stock prices
          </p>
        )}
      </div>
      {error && <ErrorNote message={error} />}
      {lines.length === 0 && <p className="text-sm text-stone-500">No recipe yet. {editable ? 'Add the ingredients one portion uses.' : ''}</p>}
      {lines.map((l, i) => {
        const ing = byId.get(l.ingredientId);
        const fits = ing ? units.filter((u) => u.dimension === ing.baseUnit.dimension) : [];
        const cost = costById.get(l.ingredientId);
        return (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_6rem_5.5rem_auto] items-end gap-2 sm:grid-cols-[minmax(0,1fr)_7rem_6rem_6rem_auto]" data-testid="recipe-line">
            <Select label="Ingredient" value={l.ingredientId} disabled={!editable} onChange={(e) => update(i, { ingredientId: e.target.value, unit: byId.get(e.target.value)?.baseUnit.code ?? l.unit })}>
              <option value="">Choose…</option>
              {active.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </Select>
            <Input label="Amount" inputMode="decimal" value={l.quantity} disabled={!editable} onChange={(e) => update(i, { quantity: e.target.value.trim() })} hint={cost && !dirty ? `≈ ${rupees(cost)}` : undefined} />
            <Select label="Unit" value={l.unit} disabled={!editable || !ing} onChange={(e) => update(i, { unit: e.target.value })}>
              {fits.map((u) => (
                <option key={u.id} value={u.code}>
                  {u.code}
                </option>
              ))}
            </Select>
            <div className="col-span-3 sm:col-span-1">
              <Input label="Waste %" inputMode="decimal" placeholder="0" value={l.wastagePercent} disabled={!editable} onChange={(e) => update(i, { wastagePercent: e.target.value.trim() })} />
            </div>
            {editable && (
              <Button variant="ghost" className="h-11" aria-label={`Remove ${ing?.name ?? 'line'}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                <X className="size-4" aria-hidden />
              </Button>
            )}
          </div>
        );
      })}
      {recipe && !dirty && recipe.items.length > 0 && (
        <p className="text-xs text-stone-500">
          One portion takes{' '}
          {recipe.items.map((i) => `${stockQty(i.perPortion, i.baseUnit)} ${byId.get(i.ingredientId)?.name ?? i.ingredientName}`).join(', ')} out of stock (waste included).
        </p>
      )}
      {editable && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-stone-100 pt-3">
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" disabled={active.length === 0} onClick={() => setLines((ls) => [...ls, { ingredientId: '', quantity: '', unit: '', wastagePercent: '' }])}>
              <Plus className="size-4" aria-hidden /> Add ingredient
            </Button>
            {recipe && (
              <Button variant="ghost" size="sm" className="text-red-700" loading={busy} onClick={() => run(onDelete)}>
                Remove recipe
              </Button>
            )}
          </div>
          <div className="flex items-center gap-3">
            {dirty && problem && <span className="text-sm text-amber-800">{problem}</span>}
            <Button
              loading={busy}
              disabled={!dirty || !!problem || lines.length === 0}
              onClick={() => run(() => onSave(lines.map((l) => ({ ingredientId: l.ingredientId, quantity: l.quantity, unit: l.unit, wastagePercent: l.wastagePercent || undefined }))))}
            >
              Save recipe
            </Button>
          </div>
        </div>
      )}
      {active.length === 0 && editable && <p className="text-sm text-stone-500">Add ingredients on the Stock tab first.</p>}
    </Card>
  );
}
