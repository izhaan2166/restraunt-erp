'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Spinner } from '@/components/ui';
import { homeFor } from '@/lib/nav';
import { useSession } from '@/lib/session';

export default function Home() {
  const { status, can } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (status === 'signed-out') router.replace('/login');
    if (status === 'signed-in') router.replace(homeFor(can));
  }, [status, can, router]);
  return <Spinner />;
}
