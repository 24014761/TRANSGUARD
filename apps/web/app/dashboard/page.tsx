'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import TopBar from '@/components/TopBar';
import { supabase, Profile, ROLE_LABEL } from '@/lib/supabase';
import OperatorDashboard from '@/components/OperatorDashboard';
import CouncillorDashboard from '@/components/CouncillorDashboard';
import CrewDashboard from '@/components/CrewDashboard';
import AdminDashboard from '@/components/AdminDashboard';

export default function Dashboard() {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState('');
  const [adminView, setAdminView] = useState<'ops' | 'admin'>('ops');

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) return router.replace('/login');
      const { data: p, error } = await supabase.from('profiles').select('*').eq('id', data.session.user.id).maybeSingle();
      if (error || !p) return setError('This account has no TransGuard role. Ask the system admin.');
      if (p.status !== 'active') return setError('This account is disabled.');
      setProfile(p as Profile);
    })();
    const { data: sub } = supabase.auth.onAuthStateChange((e) => { if (e === 'SIGNED_OUT') router.replace('/login'); });
    return () => sub.subscription.unsubscribe();
  }, [router]);

  const signOut = async () => { await supabase.auth.signOut(); router.replace('/'); };

  return (
    <>
      <TopBar right={profile && (
        <>
          <span className="who">{profile.display_name} . {ROLE_LABEL[profile.role]}</span>
          <button className="btn ghost sm" onClick={signOut}>Sign out</button>
        </>
      )} />
      <main className="container" style={{ paddingBottom: '2rem' }}>
        {error && <div className="error" style={{ marginTop: '1rem' }}>{error} <button className="btn sm" onClick={signOut}>Sign out</button></div>}
        {!profile && !error && <p className="muted" style={{ marginTop: '2rem' }}>Loading...</p>}
        {profile?.role === 'system_admin' && (
          <div className="row" style={{ marginTop: '1rem' }}>
            <button className={`btn sm ${adminView === 'ops' ? '' : 'light'}`} onClick={() => setAdminView('ops')}>Operations</button>
            <button className={`btn sm ${adminView === 'admin' ? '' : 'light'}`} onClick={() => setAdminView('admin')}>Administration</button>
          </div>
        )}
        {profile?.role === 'eskom_operator' && <OperatorDashboard profile={profile} />}
        {profile?.role === 'system_admin' && (adminView === 'ops' ? <OperatorDashboard profile={profile} /> : <AdminDashboard profile={profile} />)}
        {profile?.role === 'councillor' && <CouncillorDashboard profile={profile} />}
        {profile?.role === 'eskom_crew' && <CrewDashboard />}
        {profile?.role === 'municipal_admin' && <AdminDashboard profile={profile} />}
      </main>
    </>
  );
}
