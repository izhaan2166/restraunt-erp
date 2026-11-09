'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { MANAGE_NAV } from '@/lib/nav';
import { useSession } from '@/lib/session';

/** Owner and manager screens: menu, staff, table layout, branches. Each tab needs its own rights. */
export default function ManageLayout({ children }: { children: ReactNode }) {
  const { can } = useSession();
  const path = usePathname();
  const tabs = MANAGE_NAV.filter((n) => n.anyOf.some((p) => can(p)));
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-3 sm:p-4">
      <nav aria-label="Manage" className="flex gap-1 overflow-x-auto border-b border-stone-200">
        {tabs.map((t) => {
          const active = path === t.href || path.startsWith(t.href + '/');
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active ? 'page' : undefined}
              className={cn('-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium', active ? 'border-brand-600 text-brand-700' : 'border-transparent text-stone-600 hover:text-stone-900')}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
