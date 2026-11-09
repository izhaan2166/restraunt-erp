'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Spinner } from '@/components/ui';
import { MANAGE_NAV } from '@/lib/nav';
import { useSession } from '@/lib/session';

export default function ManageHome() {
  const { can } = useSession();
  const router = useRouter();
  useEffect(() => {
    const first = MANAGE_NAV.find((n) => n.anyOf.some((p) => can(p)));
    router.replace(first?.href ?? '/no-access');
  }, [can, router]);
  return <Spinner />;
}
