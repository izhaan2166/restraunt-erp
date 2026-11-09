'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useState } from 'react';
import { Button, Input } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { AuthCard } from '@/components/auth-card';

const POLICY = 'At least 10 characters, with a letter and a digit.';
const meetsPolicy = (p: string) => p.length >= 10 && p.length <= 128 && /[A-Za-z]/.test(p) && /\d/.test(p);

function ResetForm() {
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!token) return <p className="text-sm text-red-700">This link is incomplete. Open the link from the email again, or request a new one.</p>;
  if (done)
    return (
      <div className="flex flex-col gap-4">
        <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Password changed. You have been signed out everywhere; sign in with the new password.
        </p>
        <Link href="/login" className="text-center text-sm text-brand-700 hover:underline">
          Sign in
        </Link>
      </div>
    );

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/reset-password', { token, newPassword: password });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const mismatch = confirm.length > 0 && confirm !== password;
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Input label="New password" type="password" autoComplete="new-password" hint={POLICY} value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
      <Input label="Repeat new password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={mismatch ? 'The passwords do not match' : null} />
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <Button type="submit" size="lg" loading={busy} disabled={!meetsPolicy(password) || password !== confirm}>
        Set new password
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <AuthCard title="Choose a new password">
      <Suspense>
        <ResetForm />
      </Suspense>
    </AuthCard>
  );
}
