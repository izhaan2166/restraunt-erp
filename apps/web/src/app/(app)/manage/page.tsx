'use client';

import { FirstTab } from '@/components/section-tabs';
import { MANAGE_NAV } from '@/lib/nav';

export default function ManageHome() {
  return <FirstTab items={MANAGE_NAV} />;
}
