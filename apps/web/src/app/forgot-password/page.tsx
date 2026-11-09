'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { Button, Input } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { AuthCard } from '@/components/auth-card';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/forgot-password', { email: email.trim() });
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Reset your password" subtitle="We will email you a link that works once, for 30 minutes.">
      {sent ? (
        <div className="flex flex-col gap-4">
          <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            If an account exists for {email}, a reset link is on its way. Check your inbox.
          </p>
          <Link href="/login" className="text-center text-sm text-brand-700 hover:underline">
            Back to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Input label="Work email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <Button type="submit" size="lg" loading={busy} disabled={!email}>
            Send reset link
          </Button>
          <Link href="/login" className="text-center text-sm text-brand-700 hover:underline">
            Back to sign in
          </Link>
        </form>
      )}
    </AuthCard>
  );
}
