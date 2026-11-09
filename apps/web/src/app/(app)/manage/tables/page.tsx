'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Save } from 'lucide-react';
import { PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '@/components/toast';
import { Badge, Button, Card, Empty, ErrorNote, Input, PageHeader, Select, Spinner } from '@/components/ui';
import { ApiError, api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useBranch } from '@/lib/session';
import type { TableRow } from '@/lib/types';

const GRID = 20;
const snap = (n: number) => Math.max(0, Math.round(n / GRID) * GRID);
interface Pos {
  posX: number;
  posY: number;
  width: number;
  height: number;
}

/**
 * Table layout for the selected branch: drag tables to where they stand, add, rename, resize or take
 * them out of service. Positions are saved together with one "Save layout".
 */
export default function TableLayoutPage() {
  const branch = useBranch();
  const qc = useQueryClient();
  const toast = useToast();
  const tables = useQuery({ queryKey: ['tables', branch.id], queryFn: () => api.get<TableRow[]>(`/branches/${branch.id}/tables`) });
  const [moved, setMoved] = useState<Record<string, Pos>>({});
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);

  // Positions are local until saved; a branch switch starts over.
  useEffect(() => setMoved({}), [branch.id]);

  const rows = useMemo(() => (tables.data ?? []).map((t) => ({ ...t, ...moved[t.id] })), [tables.data, moved]);
  const dirty = Object.keys(moved).length > 0;

  function start(e: ReactPointerEvent, t: TableRow) {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    drag.current = { id: t.id, dx: e.clientX - box.left, dy: e.clientY - box.top };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setSelected(t.id);
  }
  function move(e: ReactPointerEvent) {
    const d = drag.current;
    const area = canvas.current?.getBoundingClientRect();
    if (!d || !area) return;
    const t = rows.find((r) => r.id === d.id)!;
    const posX = snap(e.clientX - area.left + (canvas.current?.scrollLeft ?? 0) - d.dx);
    const posY = snap(e.clientY - area.top + (canvas.current?.scrollTop ?? 0) - d.dy);
    if (posX !== t.posX || posY !== t.posY) setMoved((m) => ({ ...m, [d.id]: { posX, posY, width: t.width, height: t.height } }));
  }
  /** Arrow keys move the selected table one grid step, so the layout can be arranged without a mouse. */
  function nudge(e: React.KeyboardEvent, t: TableRow) {
    const step: Record<string, [number, number]> = { ArrowLeft: [-GRID, 0], ArrowRight: [GRID, 0], ArrowUp: [0, -GRID], ArrowDown: [0, GRID] };
    const s = step[e.key];
    if (!s) return;
    e.preventDefault();
    setMoved((m) => ({ ...m, [t.id]: { posX: Math.max(0, t.posX + s[0]), posY: Math.max(0, t.posY + s[1]), width: t.width, height: t.height } }));
  }

  async function saveLayout() {
    setSaving(true);
    try {
      await api.put(`/branches/${branch.id}/tables/layout`, { tables: Object.entries(moved).map(([id, p]) => ({ id, ...p })) });
      setMoved({});
      toast('Layout saved', 'success');
      qc.invalidateQueries({ queryKey: ['tables', branch.id] });
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setSaving(false);
    }
  }

  if (tables.isError) return <ErrorNote message={errorMessage(tables.error)} onRetry={() => tables.refetch()} />;
  if (!tables.data) return <Spinner label="Loading tables" />;

  const w = Math.max(640, ...rows.map((t) => t.posX + t.width + 80));
  const h = Math.max(400, ...rows.map((t) => t.posY + t.height + 80));
  const current = rows.find((t) => t.id === selected) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Table layout"
        subtitle={`${branch.name}: drag tables where they stand (or select one and use the arrow keys), then save.`}
        actions={
          <>
            <Button variant="secondary" onClick={() => setSelected('new')}>
              <Plus className="size-4" aria-hidden /> Add table
            </Button>
            <Button onClick={saveLayout} disabled={!dirty} loading={saving}>
              <Save className="size-4" aria-hidden /> Save layout
            </Button>
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div ref={canvas} className="relative overflow-auto rounded-xl border border-stone-200 bg-white bg-[radial-gradient(circle,#d6d3d1_1px,transparent_1px)] [background-size:20px_20px]" style={{ height: Math.min(h, 640) }}>
          {rows.length === 0 && <Empty title="No tables yet">Add the first table.</Empty>}
          <div className="relative" style={{ width: w, height: h }}>
            {rows.map((t) => (
              <button
                key={t.id}
                type="button"
                onPointerDown={(e) => start(e, t)}
                onPointerMove={move}
                onPointerUp={() => (drag.current = null)}
                onKeyDown={(e) => nudge(e, t)}
                onClick={() => setSelected(t.id)}
                aria-label={`Table ${t.label}, ${t.capacity} seats${moved[t.id] ? ', moved, not saved' : ''}`}
                aria-pressed={selected === t.id}
                data-testid={`layout-${t.label}`}
                className={cn(
                  'absolute flex touch-none select-none flex-col items-center justify-center border-2 text-sm shadow-sm',
                  t.shape === 'ROUND' ? 'rounded-full' : 'rounded-xl',
                  t.status === 'OUT_OF_SERVICE' ? 'border-stone-300 bg-stone-100 text-stone-500' : 'border-emerald-400 bg-emerald-50 text-emerald-900',
                  selected === t.id && 'ring-4 ring-brand-500/40',
                  moved[t.id] && 'border-dashed',
                )}
                style={{ left: t.posX, top: t.posY, width: t.width, height: t.height }}
              >
                <span className="font-bold">{t.label}</span>
                <span className="text-xs">{t.capacity} seats</span>
              </button>
            ))}
          </div>
        </div>
        <Card className="h-fit p-4">
          {selected === 'new' ? (
            <TableForm key="new" table={null} nextPos={{ posX: snap(rows.reduce((m, t) => Math.max(m, t.posX + t.width), 0) + 40), posY: 20 }} onDone={(id) => { setSelected(id ?? null); qc.invalidateQueries({ queryKey: ['tables', branch.id] }); }} />
          ) : current ? (
            <TableForm key={current.id + current.version} table={current} onDone={() => qc.invalidateQueries({ queryKey: ['tables', branch.id] })} onDeleted={() => setSelected(null)} />
          ) : (
            <p className="text-sm text-stone-600">Select a table to change its name, seats, shape or size, or to take it out of service.</p>
          )}
        </Card>
      </div>
      {dirty && <p className="text-sm text-amber-800">You have moved {Object.keys(moved).length} table(s). Save the layout to keep the new positions.</p>}
    </div>
  );
}

function TableForm({ table, nextPos, onDone, onDeleted }: { table: TableRow | null; nextPos?: { posX: number; posY: number }; onDone: (id?: string) => void; onDeleted?: () => void }) {
  const branch = useBranch();
  const toast = useToast();
  const [f, setF] = useState({
    label: table?.label ?? '',
    area: table?.area ?? '',
    capacity: String(table?.capacity ?? 4),
    shape: (table?.shape as 'RECT' | 'ROUND') ?? 'RECT',
    width: String(table?.width ?? 80),
    height: String(table?.height ?? 80),
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const valid = f.label.trim() && Number(f.capacity) >= 1 && Number(f.capacity) <= 100 && Number(f.width) >= 40 && Number(f.height) >= 40;
  const base = `/branches/${branch.id}/tables`;

  const run = async (key: string, fn: () => Promise<unknown>, done: string, after?: () => void) => {
    setBusy(key);
    setError(null);
    try {
      const r = await fn();
      toast(done, 'success');
      if (after) after();
      else onDone((r as { id?: string } | undefined)?.id);
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'DUPLICATE_TABLE' ? 'Another table already has this name.' : errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const body = { label: f.label.trim(), area: f.area.trim() || undefined, capacity: Number(f.capacity), shape: f.shape, width: Number(f.width), height: Number(f.height) };
  return (
    <div className="flex flex-col gap-3">
      <h2 className="font-semibold">{table ? `Table ${table.label}` : 'New table'}</h2>
      {table && table.status !== 'AVAILABLE' && table.status !== 'OUT_OF_SERVICE' && <Badge tone="amber">In use now</Badge>}
      {error && <ErrorNote message={error} />}
      <div className="grid grid-cols-2 gap-3">
        <Input label="Name" value={f.label} onChange={(e) => set('label', e.target.value)} maxLength={20} placeholder="T6" />
        <Input label="Seats" type="number" min={1} max={100} value={f.capacity} onChange={(e) => set('capacity', e.target.value)} />
      </div>
      <Input label="Area (optional)" value={f.area} onChange={(e) => set('area', e.target.value)} maxLength={50} placeholder="Main hall, Patio…" />
      <div className="grid grid-cols-3 gap-3">
        <Select label="Shape" value={f.shape} onChange={(e) => set('shape', e.target.value)}>
          <option value="RECT">Square</option>
          <option value="ROUND">Round</option>
        </Select>
        <Input label="Width" type="number" min={40} max={400} step={20} value={f.width} onChange={(e) => set('width', e.target.value)} />
        <Input label="Depth" type="number" min={40} max={400} step={20} value={f.height} onChange={(e) => set('height', e.target.value)} />
      </div>
      <Button
        loading={busy === 'save'}
        disabled={!valid}
        onClick={() =>
          table
            ? run('save', () => api.patch(`${base}/${table.id}`, { ...body, version: table.version }), 'Table saved')
            : run('save', () => api.post(base, { ...body, ...nextPos }), `Table ${body.label} added`)
        }
      >
        {table ? 'Save table' : 'Add table'}
      </Button>
      {table && (
        <div className="flex flex-wrap gap-2 border-t border-stone-200 pt-3">
          <Button
            variant="secondary"
            size="sm"
            loading={busy === 'service'}
            onClick={() =>
              run('service', () => api.patch(`${base}/${table.id}/service-status`, { outOfService: table.status !== 'OUT_OF_SERVICE' }), table.status === 'OUT_OF_SERVICE' ? `${table.label} is back in service` : `${table.label} is out of service`)
            }
          >
            {table.status === 'OUT_OF_SERVICE' ? 'Back in service' : 'Out of service'}
          </Button>
          <Button variant="ghost" size="sm" className="text-red-700" loading={busy === 'delete'} onClick={() => run('delete', () => api.del(`${base}/${table.id}`), `Table ${table.label} removed`, () => (onDeleted?.(), onDone()))}>
            Remove table
          </Button>
        </div>
      )}
    </div>
  );
}
