'use client';
import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import TopBar from '@/components/TopBar';
import { supabase } from '@/lib/supabase';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const as = params.get('as') === 'councillor' ? 'Councillor' : 'Staff';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) return setError(error.message === 'Invalid login credentials' ? 'Email or password is wrong.' : error.message);
    router.replace('/dashboard');
  }

  return (
    <div className="center-box card">
      <h1 style={{ fontSize: '1.5rem' }}>{as} login</h1>
      <p className="muted">Eskom staff, councillors and admins. Accounts are created by the system admin.</p>
      {error && <div className="error" role="alert">{error}</div>}
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="email">Work email</label>
          <input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="pw">Password</label>
          <input id="pw" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button className="btn big" disabled={busy}>{busy ? 'Signing in...' : 'Sign in'}</button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <>
      <TopBar />
      <main className="container">
        <Suspense fallback={null}><LoginForm /></Suspense>
      </main>
    </>
  );
}
