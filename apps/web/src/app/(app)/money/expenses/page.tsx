'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Paperclip, Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { useToast } from '@/components/toast';
import { Badge, Button, Card, Dialog, Empty, ErrorNote, Input, PageHeader, Select, Spinner } from '@/components/ui';
import { api, errorMessage, newKey, openFile } from '@/lib/api';
import { METHOD_LABEL, MONEY_INPUT, dateTime, indiaDate, monthOf, rupees, shortDate, titleCase } from '@/lib/format';
import { useBranch, useSession } from '@/lib/session';
import type { Employee, Expense, ExpenseCategory, ExpenseSummary, PaymentMethod } from '@/lib/types';

const METHODS: PaymentMethod[] = ['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'WALLET', 'OTHER'];
const MAX_RECEIPT = 5 * 1024 * 1024;

/** Money the branch spends: rent, gas, repairs. Each one can carry a photo of its bill. */
export default function ExpensesPage() {
  const branch = useBranch();
  const { can } = useSession();
  const [month, setMonth] = useState(() => indiaDate().slice(0, 7));
  const [categoryId, setCategoryId] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);
  const [editing, setEditing] = useState<Expense | 'new' | null>(null);
  const [managing, setManaging] = useState(false);
  const { from, to } = monthOf(`${month}-01`);
  const categories = useQuery({ queryKey: ['expense-categories'], queryFn: () => api.get<ExpenseCategory[]>('/expense-categories', { includeInactive: true }) });
  const query = { branchId: branch.id, from, to, categoryId: categoryId || undefined, includeDeleted: showDeleted || undefined };
  const expenses = useQuery({ queryKey: ['expenses', branch.id, query], queryFn: () => api.all<Expense>('/expenses', query) });
  const summary = useQuery({ queryKey: ['expenses', branch.id, 'summary', from, to], queryFn: () => api.get<ExpenseSummary>('/expenses/summary', { branchId: branch.id, from, to }) });

  const error = categories.error ?? expenses.error;
  if (error) return <ErrorNote message={errorMessage(error)} onRetry={() => (categories.refetch(), expenses.refetch())} />;
  if (!categories.data || !expenses.data) return <Spinner label="Loading expenses" />;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Expenses"
        subtitle={`What ${branch.name} spends, with the bills attached.`}
        actions={
          <div className="flex gap-2">
            {can('expenses.update') && (
              <Button variant="secondary" onClick={() => setManaging(true)}>
                Categories
              </Button>
            )}
            {can('expenses.create', branch.id) && (
              <Button onClick={() => setEditing('new')} disabled={!categories.data.some((c) => c.isActive)}>
                <Plus className="size-4" aria-hidden /> Add expense
              </Button>
            )}
          </div>
        }
      />
      <div className="flex flex-wrap items-end gap-3">
        <Input label="Month" type="month" value={month} max={indiaDate().slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} className="w-44" />
        <Select label="Category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="w-48">
          <option value="">All categories</option>
          {categories.data.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <label className="flex h-11 items-center gap-2 text-sm">
          <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} /> Show deleted
        </label>
      </div>
      {summary.data && summary.data.count > 0 && (
        <Card className="flex flex-col gap-2 p-4">
          <p>
            <span className="text-sm text-stone-600">Spent this month </span>
            <span className="text-xl font-semibold tabular-nums" data-testid="expense-total">
              {rupees(summary.data.total)}
            </span>
            <span className="text-sm text-stone-600">
              {' '}
              in {summary.data.count} {summary.data.count === 1 ? 'expense' : 'expenses'}, GST {rupees(summary.data.taxTotal)}
            </span>
          </p>
          <p className="text-sm text-stone-600">{summary.data.byCategory.map((c) => `${c.name} ${rupees(c.amount)}`).join(' · ')}</p>
        </Card>
      )}
      {expenses.data.length === 0 ? (
        <Empty title="No expenses this month" />
      ) : (
        <Card>
          <ul className="divide-y divide-stone-100">
            {expenses.data.map((e) => (
              <li key={e.id}>
                <button className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-stone-50" onClick={() => setEditing(e)} data-testid="expense-row">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {e.description} {e.deletedAt && <Badge tone="red">Deleted</Badge>} {e.receiptUrl && <Paperclip className="inline size-3.5 text-stone-500" aria-label="Has receipt" />}
                    </p>
                    <p className="truncate text-xs text-stone-500">
                      {[shortDate(e.expenseDate), e.category.name, METHOD_LABEL[e.paymentMethod], e.cashSessionId && 'from drawer', e.paidTo && `to ${e.paidTo}`, e.employee?.fullName].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <span className={e.deletedAt ? 'tabular-nums text-stone-400 line-through' : 'font-semibold tabular-nums'}>{rupees(e.amount)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {editing && <ExpenseDialog expense={editing === 'new' ? null : editing} categories={categories.data} onClose={() => setEditing(null)} />}
      {managing && <CategoriesDialog categories={categories.data} onClose={() => setManaging(false)} />}
    </div>
  );
}

function ExpenseDialog({ expense, categories, onClose }: { expense: Expense | null; categories: ExpenseCategory[]; onClose: () => void }) {
  const branch = useBranch();
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const isNew = !expense;
  const editable = !expense?.deletedAt && (isNew ? can('expenses.create', branch.id) : can('expenses.update'));
  const employees = useQuery({ queryKey: ['employees', branch.id], queryFn: () => api.all<Employee>('/employees', { branchId: branch.id }), enabled: can('employees.read', branch.id) });
  const [f, setF] = useState({
    categoryId: expense?.categoryId ?? categories.find((c) => c.isActive)?.id ?? '',
    amount: expense?.amount ?? '',
    taxAmount: expense && Number(expense.taxAmount) ? expense.taxAmount : '',
    description: expense?.description ?? '',
    expenseDate: expense?.expenseDate.slice(0, 10) ?? indiaDate(),
    paymentMethod: (expense?.paymentMethod ?? 'CASH') as PaymentMethod,
    paidTo: expense?.paidTo ?? '',
    employeeId: expense?.employeeId ?? '',
    fromCashDrawer: false,
    reason: '',
  });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteReason, setDeleteReason] = useState('');
  const [history, setHistory] = useState(false);
  const key = useRef(newKey());
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));

  const problem = !f.categoryId
    ? 'Choose a category'
    : !MONEY_INPUT.test(f.amount) || Number(f.amount) <= 0
      ? 'Enter the amount paid, like 1200 or 1200.50'
      : f.taxAmount && !MONEY_INPUT.test(f.taxAmount)
        ? 'GST should be an amount like 180 or 180.50'
        : f.taxAmount && Number(f.taxAmount) > Number(f.amount)
          ? 'GST cannot be more than the amount paid'
          : f.description.trim().length < 3
            ? 'Say what it was for'
            : f.expenseDate > indiaDate()
              ? 'The date cannot be in the future'
              : file && file.size > MAX_RECEIPT
                ? 'The receipt file is over 5 MB'
                : !isNew && f.reason.trim().length < 3
                  ? 'Say why you are changing it'
                  : null;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      let id = expense?.id;
      const fields = {
        categoryId: f.categoryId,
        amount: f.amount,
        taxAmount: f.taxAmount || '0',
        description: f.description.trim(),
        expenseDate: f.expenseDate,
        paymentMethod: f.paymentMethod,
        paidTo: f.paidTo.trim() || undefined,
      };
      if (isNew) {
        const created = await api.post<Expense>(
          '/expenses',
          { ...fields, branchId: branch.id, employeeId: f.employeeId || undefined, fromCashDrawer: f.paymentMethod === 'CASH' && f.fromCashDrawer ? true : undefined },
          key.current,
        );
        id = created.id;
      } else {
        await api.patch(`/expenses/${id}`, { ...fields, employeeId: f.employeeId || null, reason: f.reason.trim() });
      }
      if (file && id) {
        try {
          await api.upload(`/expenses/${id}/receipt`, 'receipt', file);
        } catch (err) {
          await qc.invalidateQueries({ queryKey: ['expenses', branch.id] });
          setError(`The expense is saved, but the receipt did not upload: ${errorMessage(err)}`);
          return;
        }
      }
      await qc.invalidateQueries({ queryKey: ['expenses', branch.id] });
      if (f.fromCashDrawer) await qc.invalidateQueries({ queryKey: ['shift-report'] });
      toast(isNew ? `Expense of ${rupees(f.amount)} added` : 'Expense saved', 'success');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!expense) return;
    setBusy(true);
    setError(null);
    try {
      await api.del(`/expenses/${expense.id}`, { reason: deleteReason.trim() });
      await qc.invalidateQueries({ queryKey: ['expenses', branch.id] });
      toast('Expense deleted', 'success');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const choosable = categories.filter((c) => c.isActive || c.id === f.categoryId);

  return (
    <Dialog
      open
      onClose={onClose}
      title={isNew ? 'Add expense' : expense.description}
      footer={
        deleting ? (
          <>
            <Button variant="ghost" onClick={() => setDeleting(false)}>
              Keep it
            </Button>
            <Button variant="danger" loading={busy} disabled={deleteReason.trim().length < 3} onClick={remove}>
              Delete expense
            </Button>
          </>
        ) : (
          <>
            {expense && !expense.deletedAt && can('expenses.delete') && (
              <Button variant="ghost" className="mr-auto text-red-700" onClick={() => setDeleting(true)}>
                Delete
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}>
              {editable ? 'Cancel' : 'Close'}
            </Button>
            {editable && (
              <Button loading={busy} disabled={!!problem} onClick={save}>
                {isNew ? 'Add expense' : 'Save'}
              </Button>
            )}
          </>
        )
      }
    >
      <div className="flex flex-col gap-3">
        {error && <ErrorNote message={error} />}
        {expense?.deletedAt && <p className="text-sm text-red-700">Deleted{expense.deleteReason ? `: ${expense.deleteReason}` : ''}</p>}
        {deleting ? (
          <Input label="Why delete it" value={deleteReason} maxLength={300} placeholder="Entered twice" onChange={(e) => setDeleteReason(e.target.value)} />
        ) : (
          <>
            <Input label="What was it for" value={f.description} maxLength={300} placeholder="Gas cylinder refill" disabled={!editable} onChange={(e) => set({ description: e.target.value })} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Select label="Category" value={f.categoryId} disabled={!editable} onChange={(e) => set({ categoryId: e.target.value })}>
                {choosable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
              <Input label="Date" type="date" value={f.expenseDate} max={indiaDate()} disabled={!editable} onChange={(e) => set({ expenseDate: e.target.value })} />
              <Input label="Amount paid (₹)" inputMode="decimal" value={f.amount} disabled={!editable} hint="Including GST" onChange={(e) => set({ amount: e.target.value.trim() })} />
              <Input label="GST in it (₹, optional)" inputMode="decimal" value={f.taxAmount} disabled={!editable} onChange={(e) => set({ taxAmount: e.target.value.trim() })} />
              <Select label="Paid by" value={f.paymentMethod} disabled={!editable} onChange={(e) => set({ paymentMethod: e.target.value as PaymentMethod })}>
                {METHODS.map((m) => (
                  <option key={m} value={m}>
                    {METHOD_LABEL[m]}
                  </option>
                ))}
              </Select>
              <Input label="Paid to (optional)" value={f.paidTo} maxLength={120} placeholder="Shop or person" disabled={!editable} onChange={(e) => set({ paidTo: e.target.value })} />
              {employees.data && (
                <Select label="Staff member (optional)" value={f.employeeId} disabled={!editable} onChange={(e) => set({ employeeId: e.target.value })}>
                  <option value="">Nobody</option>
                  {employees.data
                    .filter((x) => x.isActive || x.id === f.employeeId)
                    .map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.fullName}
                      </option>
                    ))}
                </Select>
              )}
            </div>
            {isNew && f.paymentMethod === 'CASH' && can('cash.movement') && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={f.fromCashDrawer} onChange={(e) => set({ fromCashDrawer: e.target.checked })} /> Paid from the cash drawer (needs your shift open)
              </label>
            )}
            {expense?.cashSessionId && <p className="text-sm text-stone-600">Paid from the cash drawer.</p>}
            <div className="flex flex-wrap items-center gap-3">
              {expense?.receiptUrl && (
                <Button variant="secondary" size="sm" onClick={() => openFile(`/expenses/${expense.id}/receipt`).catch((err) => setError(errorMessage(err)))}>
                  <Paperclip className="size-4" aria-hidden /> View receipt
                </Button>
              )}
              {editable && (
                <label className="text-sm">
                  <span className="mb-1 block font-medium">{expense?.receiptUrl ? 'Replace receipt' : 'Receipt photo or PDF (optional)'}</span>
                  <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label="Receipt file" />
                </label>
              )}
            </div>
            {!isNew && editable && <Input label="Why are you changing it" value={f.reason} maxLength={300} placeholder="Bill amount corrected" onChange={(e) => set({ reason: e.target.value })} />}
            {editable && problem && f.description && <p className="text-sm text-amber-800">{problem}</p>}
            {expense && (
              <button className="self-start text-sm text-brand-700 underline" onClick={() => setHistory((h) => !h)}>
                {history ? 'Hide changes' : 'Show changes'}
              </button>
            )}
            {expense && history && <History id={expense.id} />}
          </>
        )}
      </div>
    </Dialog>
  );
}

function History({ id }: { id: string }) {
  const h = useQuery({ queryKey: ['expense-history', id], queryFn: () => api.get<{ action: string; at: string; by: { fullName: string } | null }[]>(`/expenses/${id}/history`) });
  if (h.isError) return <ErrorNote message={errorMessage(h.error)} />;
  if (!h.data) return <Spinner />;
  return (
    <ul className="text-xs text-stone-600" aria-label="Changes">
      {h.data.map((x, i) => (
        <li key={i}>
          {dateTime(x.at)} · {titleCase(x.action.replace(/^expense\./, ''))} by {x.by?.fullName ?? 'system'}
        </li>
      ))}
    </ul>
  );
}

function CategoriesDialog({ categories, onClose }: { categories: ExpenseCategory[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (id: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(id);
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['expense-categories'] });
      toast(done, 'success');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Dialog open onClose={onClose} title="Expense categories" footer={<Button variant="ghost" onClick={onClose}>Close</Button>}>
      <div className="flex flex-col gap-3">
        {error && <ErrorNote message={error} />}
        <ul className="divide-y divide-stone-100">
          {categories.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 py-2">
              <span className={c.isActive ? '' : 'text-stone-400'}>{c.name}</span>
              <Button size="sm" variant="ghost" loading={busy === c.id} onClick={() => run(c.id, () => api.patch(`/expense-categories/${c.id}`, { isActive: !c.isActive }), c.isActive ? `${c.name} hidden` : `${c.name} back in use`)}>
                {c.isActive ? 'Stop using' : 'Use again'}
              </Button>
            </li>
          ))}
        </ul>
        <div className="flex items-end gap-2">
          <Input label="New category" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} className="flex-1" />
          <Button loading={busy === 'new'} disabled={name.trim().length < 2} onClick={() => run('new', () => api.post('/expense-categories', { name: name.trim() }).then(() => setName('')), `${name.trim()} added`)}>
            Add
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
