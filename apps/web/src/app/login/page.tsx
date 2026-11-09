'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useEffect, useState } from 'react';
import { Button, Input } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import { homeFor } from '@/lib/nav';
import { AuthCard } from '@/components/auth-card';

function LoginForm() {
  const { status, login, me, can } = useSession();
  const router = useRouter();
  const next = useSearchParams().get('next');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === 'signed-in' && me) router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : homeFor(can));
  }, [status, me, can, next, router]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <Input label="Work email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
      <Input label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <Button type="submit" size="lg" loading={busy} disabled={!email || !password}>
        Sign in
      </Button>
      <Link href="/forgot-password" className="text-center text-sm text-brand-700 hover:underline">
        Forgot password?
      </Link>
    </form>
  );
}

export default function LoginPage() {
  return (
    <AuthCard title="Sign in" subtitle="Use your work email and password.">
      <Suspense>
        <LoginForm />
      </Suspense>
    </AuthCard>
  );
}
