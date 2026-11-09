'use client';

import { LogOut, Store } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ReactNode, useEffect } from 'react';
import { Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';
import { visibleNav } from '@/lib/nav';
import { useSession } from '@/lib/session';

/** Every signed-in screen: sign-in guard, navigation for the user's role, branch switcher. */
export default function AppLayout({ children }: { children: ReactNode }) {
  const { status, me, branch, setBranch, can, logout } = useSession();
  const router = useRouter();
  const path = usePathname();

  useEffect(() => {
    if (status === 'signed-out') router.replace(`/login?next=${encodeURIComponent(path)}`);
  }, [status, path, router]);

  if (status !== 'signed-in' || !me) return <Spinner label="Signing in" />;
  if (!branch)
    return (
      <main className="mx-auto max-w-md p-8 text-center">
        <h1 className="text-xl font-semibold">No branch assigned</h1>
        <p className="mt-2 text-stone-600">Your account has no role in any branch yet. Ask the owner to give you one.</p>
        <button className="mt-4 text-brand-700 underline" onClick={logout}>
          Sign out
        </button>
      </main>
    );

  const nav = visibleNav(can);
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-stone-200 bg-white px-3 sm:px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold text-brand-700">
          <Store className="size-5" aria-hidden />
          <span className="hidden sm:inline">RestaurantOS</span>
        </Link>
        <nav aria-label="Main" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {nav.map((n) => {
            const active = path === n.href || path.startsWith(n.href + '/');
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active ? 'page' : undefined}
                className={cn('flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium', active ? 'bg-brand-50 text-brand-700' : 'text-stone-600 hover:bg-stone-100')}
              >
                <n.icon className="size-4" aria-hidden />
                <span className={cn(nav.length > 3 && 'sr-only sm:not-sr-only')}>{n.label}</span>
              </Link>
            );
          })}
        </nav>
        {me.branches.length > 1 ? (
          <label className="flex items-center gap-2 text-sm">
            <span className="sr-only">Branch</span>
            <select value={branch.id} onChange={(e) => setBranch(e.target.value)} className="h-9 max-w-40 rounded-lg border border-stone-300 bg-white px-2 text-sm" data-testid="branch-switcher">
              {me.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="hidden text-sm text-stone-600 md:inline">{branch.name}</span>
        )}
        <div className="hidden text-right text-xs leading-tight text-stone-500 lg:block">
          <div className="font-medium text-stone-800">{me.user.fullName}</div>
          <div>{me.organization.name}</div>
        </div>
        <button onClick={logout} className="rounded-lg p-2 text-stone-500 hover:bg-stone-100" aria-label="Sign out" title="Sign out">
          <LogOut className="size-5" />
        </button>
      </header>
      <main className="min-h-0 flex-1 overflow-auto">{children}</main>
    </div>
  );
}
