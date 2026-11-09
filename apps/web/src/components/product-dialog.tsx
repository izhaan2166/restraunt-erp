'use client';

import { useState } from 'react';
import { rupees } from '@/lib/format';
import type { MenuProduct } from '@/lib/types';
import type { ItemInput } from '@/lib/use-order';
import { cn } from '@/lib/cn';
import { Button, Dialog, Input } from './ui';

/** Lets the cashier pick a size, add-ons and a note for one item. Prices shown are menu prices; the order total comes from the server. */
export function ProductDialog({ product, onClose, onAdd }: { product: MenuProduct; onClose: () => void; onAdd: (item: ItemInput) => void }) {
  const variants = product.variants.filter((v) => v.isAvailable);
  const [variantId, setVariantId] = useState<string | undefined>((variants.find((v) => v.isDefault) ?? variants[0])?.id);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState('');

  const toggle = (groupId: string, modifierId: string, single: boolean) =>
    setPicked((p) => {
      const cur = p[groupId] ?? [];
      if (single) return { ...p, [groupId]: cur[0] === modifierId ? [] : [modifierId] };
      return { ...p, [groupId]: cur.includes(modifierId) ? cur.filter((m) => m !== modifierId) : [...cur, modifierId] };
    });

  const problems = product.modifierGroups
    .map((g) => {
      const n = picked[g.id]?.length ?? 0;
      if (n < g.minSelect) return `Choose ${g.minSelect === 1 ? 'one' : `at least ${g.minSelect}`} ${g.name.toLowerCase()}`;
      if (g.maxSelect > 0 && n > g.maxSelect) return `Choose at most ${g.maxSelect} ${g.name.toLowerCase()}`;
      return null;
    })
    .filter(Boolean) as string[];

  const add = () =>
    onAdd({
      productId: product.id,
      variantId: variants.length ? variantId : undefined,
      quantity: String(quantity),
      modifiers: Object.values(picked)
        .flat()
        .map((modifierId) => ({ modifierId })),
      instructions: note.trim() || undefined,
    });

  return (
    <Dialog
      open
      onClose={onClose}
      title={product.name}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={add} disabled={problems.length > 0 || (variants.length > 0 && !variantId)}>
            Add to order
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {variants.length > 0 && (
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-stone-700">Size</legend>
            <div className="grid grid-cols-2 gap-2">
              {variants.map((v) => (
                <Choice key={v.id} selected={variantId === v.id} onClick={() => setVariantId(v.id)} label={v.name} price={rupees(v.price)} role="radio" />
              ))}
            </div>
          </fieldset>
        )}
        {product.modifierGroups.map((g) => {
          const single = g.maxSelect === 1;
          return (
            <fieldset key={g.id}>
              <legend className="mb-2 text-sm font-medium text-stone-700">
                {g.name}
                <span className="ml-2 font-normal text-stone-500">{g.minSelect > 0 ? 'Required' : 'Optional'}{g.maxSelect > 1 ? `, up to ${g.maxSelect}` : ''}</span>
              </legend>
              <div className="grid grid-cols-2 gap-2">
                {g.modifiers.map((m) => (
                  <Choice
                    key={m.id}
                    role={single ? 'radio' : 'checkbox'}
                    selected={picked[g.id]?.includes(m.id) ?? false}
                    onClick={() => toggle(g.id, m.id, single)}
                    label={m.name}
                    price={Number(m.price) > 0 ? `+ ${rupees(m.price)}` : undefined}
                  />
                ))}
              </div>
            </fieldset>
          );
        })}
        <div className="flex items-end gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-stone-700">Quantity</span>
            <div className="flex items-center gap-2">
              <Button variant="secondary" aria-label="One less" onClick={() => setQuantity((q) => Math.max(1, q - 1))}>
                −
              </Button>
              <span className="w-8 text-center text-lg font-semibold tabular-nums" aria-live="polite">
                {quantity}
              </span>
              <Button variant="secondary" aria-label="One more" onClick={() => setQuantity((q) => q + 1)}>
                +
              </Button>
            </div>
          </div>
          <div className="flex-1">
            <Input label="Note for the kitchen" placeholder="Less spicy, no onion…" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
        {problems.length > 0 && <p className="text-sm text-amber-800">{problems[0]}</p>}
      </div>
    </Dialog>
  );
}

function Choice({ selected, onClick, label, price, role }: { selected: boolean; onClick: () => void; label: string; price?: string; role: 'radio' | 'checkbox' }) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={selected}
      onClick={onClick}
      className={cn('flex min-h-12 items-center justify-between gap-2 rounded-lg border px-3 text-left text-sm', selected ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-stone-300 bg-white hover:bg-stone-50')}
    >
      <span className="font-medium">{label}</span>
      {price && <span className="text-stone-500 tabular-nums">{price}</span>}
    </button>
  );
}
