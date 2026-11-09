'use client';

import { FirstTab } from '@/components/section-tabs';
import { STOCK_NAV } from '@/lib/nav';

export default function StockHome() {
  return <FirstTab items={STOCK_NAV} />;
}
