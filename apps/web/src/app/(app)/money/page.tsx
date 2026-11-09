'use client';

import { FirstTab } from '@/components/section-tabs';
import { MONEY_NAV } from '@/lib/nav';

export default function MoneyHome() {
  return <FirstTab items={MONEY_NAV} />;
}
