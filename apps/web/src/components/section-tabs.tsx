'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ReactNode, useEffect } from 'react';
import { Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { NavItem } from '@/lib/nav';
import { useSession } from '@/lib/session';

/** A section with tabs (Manage, Stock): each tab shows only for people with one of its rights. */
export function SectionLayout({ label, items, children }: { label: string; items: NavItem[]; children: ReactNode }) {
  const { can } = useSession();
  const path = usePathname();
  const tabs = items.filter((n) => n.anyOf.some((p) => can(p)));
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-3 sm:p-4">
      <nav aria-label={label} className="flex gap-1 overflow-x-auto border-b border-stone-200">
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

/** The section's own address opens its first tab the person may use. */
export function FirstTab({ items }: { items: NavItem[] }) {
  const { can } = useSession();
  const router = useRouter();
  useEffect(() => {
    const first = items.find((n) => n.anyOf.some((p) => can(p)));
    router.replace(first?.href ?? '/no-access');
  }, [can, router, items]);
  return <Spinner />;
}
