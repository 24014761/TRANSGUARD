'use client';
import { useEffect, useState } from 'react';
import { supabase, Profile } from '@/lib/supabase';
import { post } from '@/lib/api';
import { useIncidents, useNow } from './hooks';
import IncidentCard from './IncidentCard';

type Verif = { id: string; incident_id: string; decision: string; note: string | null; decided_at: string };
type Msg = { id: string; recipient_role: string; body: string; sent_at: string };

const DECISION_LABEL: Record<string, string> = { confirmed: 'Yes, no electricity', power_on: 'No, power is on', unsafe: "I can't check safely" };
const TABS = ['Confirm outages', 'Ward incidents', 'My decisions', 'Messages'] as const;

export default function CouncillorDashboard({ profile }: { profile: Profile }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Confirm outages');
  const { items, reload } = useIncidents('open');
  const { items: history } = useIncidents('all');
  const [verifs, setVerifs] = useState<Verif[]>([]);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ ok?: string; err?: string }>({});
  const now = useNow();

  const loadSide = () => {
    supabase.from('verifications').select('*').order('decided_at', { ascending: false }).then(({ data }) => setVerifs((data as Verif[]) || []));
    supabase.from('messages').select('*').order('sent_at', { ascending: false }).limit(50).then(({ data }) => setMsgs((data as Msg[]) || []));
  };
  useEffect(loadSide, [items.length]);

  const waiting = items.filter((i) => i.status === 'VERIFYING');

  async function decide(id: string, decision: string) {
    setStatus({});
    try {
      await post(`/incidents/${id}/verify`, { decision, note: notes[id] || undefined });
      setStatus({ ok: `Thank you. Your answer "${DECISION_LABEL[decision]}" was sent to Eskom.` });
      reload();
      loadSide();
    } catch (e) {
      setStatus({ err: (e as Error).message });
    }
  }

  return (
    <>
      <p className="muted">Ward: <strong>{profile.ward_id}</strong></p>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (<button key={t} role="tab" className="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t}{t === 'Confirm outages' && waiting.length ? ` (${waiting.length})` : ''}</button>))}
      </div>
      {status.ok && <div className="ok" role="status">{status.ok}</div>}
      {status.err && <div className="error" role="alert">{status.err}</div>}

      {tab === 'Confirm outages' && (
        <div className="grid c2">
          {waiting.length === 0 && <div className="card muted">Nothing to confirm right now. You will get an SMS when Eskom needs you.</div>}
          {waiting.map((i) => {
            const left = i.verify_deadline ? Math.max(0, new Date(i.verify_deadline).getTime() - now) : 0;
            const mm = Math.floor(left / 60000), ss = Math.floor((left % 60000) / 1000);
            return (
              <IncidentCard key={i.id} incident={i} showHint={false}>
                <div style={{ width: '100%' }}>
                  <p style={{ margin: '0 0 .5rem' }}>Is there really no electricity at <strong>{i.transformers?.name || i.transformer_id}</strong>?</p>
                  <div className="countdown" aria-live="polite">{String(mm).padStart(2, '0')}:{String(ss).padStart(2, '0')}</div>
                  <p className="muted" style={{ marginTop: 0 }}>If you do not answer in time, Eskom sends the crew as unverified.</p>
                  <div className="field">
                    <label htmlFor={`n-${i.id}`}>Note (optional)</label>
                    <input id={`n-${i.id}`} maxLength={500} value={notes[i.id] || ''} onChange={(e) => setNotes({ ...notes, [i.id]: e.target.value })} />
                  </div>
                  <div className="grid">
                    <button className="btn big green" onClick={() => decide(i.id, 'confirmed')}>Yes, no electricity</button>
                    <button className="btn big light" onClick={() => decide(i.id, 'power_on')}>No, power is on</button>
                    <button className="btn big orange" onClick={() => decide(i.id, 'unsafe')}>I can&apos;t check safely</button>
                  </div>
                </div>
              </IncidentCard>
            );
          })}
        </div>
      )}

      {tab === 'Ward incidents' && (
        <div className="grid c2">
          {history.map((i) => <IncidentCard key={i.id} incident={i} />)}
          {!history.length && <div className="card muted">No incidents in your ward.</div>}
        </div>
      )}

      {tab === 'My decisions' && (
        <div className="table-wrap"><table>
          <thead><tr><th>When</th><th>Incident</th><th>Answer</th><th>Note</th></tr></thead>
          <tbody>
            {verifs.map((v) => (<tr key={v.id}><td>{new Date(v.decided_at).toLocaleString('en-ZA')}</td><td>{v.incident_id.slice(0, 8)}</td><td>{DECISION_LABEL[v.decision]}</td><td>{v.note}</td></tr>))}
            {!verifs.length && <tr><td colSpan={4} className="muted">No decisions yet.</td></tr>}
          </tbody>
        </table></div>
      )}

      {tab === 'Messages' && (
        <div className="table-wrap"><table>
          <thead><tr><th>Sent</th><th>To</th><th>Message</th></tr></thead>
          <tbody>
            {msgs.map((m) => (<tr key={m.id}><td>{new Date(m.sent_at).toLocaleString('en-ZA')}</td><td>{m.recipient_role}</td><td>{m.body}</td></tr>))}
            {!msgs.length && <tr><td colSpan={3} className="muted">No messages.</td></tr>}
          </tbody>
        </table></div>
      )}
    </>
  );
}
