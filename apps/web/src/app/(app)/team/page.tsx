'use client';

import { FirstTab } from '@/components/section-tabs';
import { TEAM_NAV } from '@/lib/nav';

export default function TeamHome() {
  return <FirstTab items={TEAM_NAV} />;
}
