'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock } from 'lucide-react';
import { useState } from 'react';
import { useToast } from '@/components/toast';
import { ApiError, api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { indiaDate, time } from '@/lib/format';
import { useBranch } from '@/lib/session';
import type { AttendanceRow, Employee } from '@/lib/types';

/** Clock in and out from the top bar. Shown only to people with an employee record tied to their sign-in. */
export function ClockButton() {
  const branch = useBranch();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const me = useQuery({
    queryKey: ['employee-me'],
    queryFn: async () => {
      try {
        return await api.get<Employee>('/employees/me');
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
  const yesterday = indiaDate(new Date(Date.now() - 86_400_000));
  const mine = useQuery({
    queryKey: ['attendance-me'],
    queryFn: () => api.get<AttendanceRow[]>('/attendance/me', { from: yesterday, to: indiaDate() }),
    enabled: !!me.data,
  });
  if (!me.data || !mine.data) return null;
  const open = mine.data.find((r) => r.clockInAt && !r.clockOutAt);

  async function flip() {
    setBusy(true);
    try {
      if (open) await api.post('/attendance/clock-out', {});
      else await api.post('/attendance/clock-in', { branchId: branch.id });
      await qc.invalidateQueries({ queryKey: ['attendance-me'] });
      await qc.invalidateQueries({ queryKey: ['attendance'] });
      toast(open ? 'Clocked out. See you next shift.' : 'Clocked in', 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={flip}
      disabled={busy}
      className={cn('flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-sm font-medium disabled:opacity-60', open ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-stone-300 text-stone-700 hover:bg-stone-100')}
      title={open ? `Clocked in at ${time(open.clockInAt!)}` : 'Clock in for your shift'}
    >
      <Clock className="size-4" aria-hidden />
      <span>{open ? 'Clock out' : 'Clock in'}</span>
      {open && <span className="hidden text-xs font-normal sm:inline">since {time(open.clockInAt!)}</span>}
    </button>
  );
}
