'use client';

import { ReactNode } from 'react';
import { SectionLayout } from '@/components/section-tabs';
import { MANAGE_NAV } from '@/lib/nav';

/** Owner and manager screens: menu, staff, table layout, branches. Each tab needs its own rights. */
export default function ManageLayout({ children }: { children: ReactNode }) {
  return (
    <SectionLayout label="Manage" items={MANAGE_NAV}>
      {children}
    </SectionLayout>
  );
}
