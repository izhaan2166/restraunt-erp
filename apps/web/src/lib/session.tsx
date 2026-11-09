'use client';

import { useQueryClient } from '@tanstack/react-query';
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { API_BASE, ApiError, api, refreshAccessToken, request, setAccessToken } from './api';
import type { Branch, Me } from './types';

type Status = 'loading' | 'signed-out' | 'signed-in';

interface SessionValue {
  status: Status;
  me: Me | null;
  branch: Branch | null;
  setBranch: (id: string) => void;
  /** True when the user holds the permission in the current branch (or organization-wide). */
  can: (permission: string, branchId?: string | null) => boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);
const BRANCH_KEY = 'ros.branch';

function readBranch(): string | null {
  try {
    return localStorage.getItem(BRANCH_KEY);
  } catch {
    return null;
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<Status>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [branchId, setBranchId] = useState<string | null>(null);

  const loadMe = useCallback(async () => {
    const m = await api.get<Me>('/auth/me');
    setMe(m);
    const saved = readBranch();
    setBranchId((cur) => [cur, saved].find((id) => id && m.branches.some((b) => b.id === id)) ?? m.branches[0]?.id ?? null);
    setStatus('signed-in');
  }, []);

  // Restore the session from the refresh cookie on first load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = await refreshAccessToken();
      if (cancelled) return;
      if (!token) return setStatus('signed-out');
      try {
        await loadMe();
      } catch {
        if (!cancelled) setStatus('signed-out');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadMe]);

  const login = useCallback(
    async (email: string, password: string) => {
      const r = await request<{ accessToken: string }>('/auth/login', { method: 'POST', body: { email, password }, noRefresh: true });
      setAccessToken(r.data.accessToken);
      await loadMe();
    },
    [loadMe],
  );

  const logout = useCallback(async () => {
    try {
      await fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    } catch {
      /* signing out locally is enough if the server is unreachable */
    }
    setAccessToken(null);
    setMe(null);
    qc.clear();
    setStatus('signed-out');
  }, [qc]);

  const setBranch = useCallback(
    (id: string) => {
      setBranchId(id);
      try {
        localStorage.setItem(BRANCH_KEY, id);
      } catch {
        /* private mode: the choice lasts for this tab only */
      }
      qc.invalidateQueries();
    },
    [qc],
  );

  const value = useMemo<SessionValue>(() => {
    const branch = me?.branches.find((b) => b.id === branchId) ?? null;
    return {
      status,
      me,
      branch,
      setBranch,
      can: (permission, forBranch) => {
        if (!me) return false;
        if (me.permissions.organizationWide.includes(permission)) return true;
        const id = forBranch === undefined ? branch?.id : forBranch;
        if (id) return me.permissions.byBranch[id]?.includes(permission) ?? false;
        return Object.values(me.permissions.byBranch).some((p) => p.includes(permission));
      },
      login,
      logout,
      reload: loadMe,
    };
  }, [status, me, branchId, setBranch, login, logout, loadMe]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession must be used inside SessionProvider');
  return v;
}

/** The selected branch; only used inside signed-in pages, where one always exists. */
export function useBranch(): Branch {
  const { branch } = useSession();
  if (!branch) throw new ApiError(403, 'NO_BRANCH', 'You have no branch assigned. Ask the owner to give you a role.');
  return branch;
}
