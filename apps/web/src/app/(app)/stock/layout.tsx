'use client';

import { ReactNode } from 'react';
import { SectionLayout } from '@/components/section-tabs';
import { STOCK_NAV } from '@/lib/nav';

/** Stock and purchasing: levels, recipes, purchase orders and suppliers. */
export default function StockLayout({ children }: { children: ReactNode }) {
  return (
    <SectionLayout label="Stock" items={STOCK_NAV}>
      {children}
    </SectionLayout>
  );
}
