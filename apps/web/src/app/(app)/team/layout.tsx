'use client';

import { ReactNode } from 'react';
import { SectionLayout } from '@/components/section-tabs';
import { TEAM_NAV } from '@/lib/nav';

export default function TeamLayout({ children }: { children: ReactNode }) {
  return (
    <SectionLayout label="Team" items={TEAM_NAV}>
      {children}
    </SectionLayout>
  );
}
