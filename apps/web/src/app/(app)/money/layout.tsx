'use client';

import { ReactNode } from 'react';
import { SectionLayout } from '@/components/section-tabs';
import { MONEY_NAV } from '@/lib/nav';

export default function MoneyLayout({ children }: { children: ReactNode }) {
  return (
    <SectionLayout label="Money" items={MONEY_NAV}>
      {children}
    </SectionLayout>
  );
}
