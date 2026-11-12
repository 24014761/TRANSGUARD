'use client';
import { useState } from 'react';
import { post } from '@/lib/api';
import { useIncidents } from './hooks';
import IncidentCard from './IncidentCard';

export default function CrewDashboard() {
  const { items, reload } = useIncidents('open');
  const [status, setStatus] = useState<{ ok?: string; err?: string }>({});
  const jobs = items.filter((i) => i.status === 'DISPATCHED' || i.status === 'ON_SITE');

  async function act(id: string, path: string, label: string) {
    setStatus({});
    try {
      await post(`/incidents/${id}/${path}`);
      setStatus({ ok: label });
      reload();
    } catch (e) {
      setStatus({ err: (e as Error).message });
    }
  }

  return (
    <>
      <h2 style={{ marginTop: '1rem' }}>My jobs</h2>
      {status.ok && <div className="ok" role="status">{status.ok}</div>}
      {status.err && <div className="error" role="alert">{status.err}</div>}
      <div className="grid c2">
        {jobs.length === 0 && <div className="card muted">No jobs right now.</div>}
        {jobs.map((i) => {
          const t = i.transformers;
          const nav = t ? `https://www.google.com/maps/dir/?api=1&destination=${t.lat},${t.lng}` : null;
          return (
            <IncidentCard key={i.id} incident={i}>
              {nav && <a className="btn light" href={nav} target="_blank" rel="noopener noreferrer">Navigate (GPS)</a>}
              {i.status === 'DISPATCHED' && <button className="btn" onClick={() => act(i.id, 'arrived', 'Marked as arrived.')}>I have arrived</button>}
              <button className="btn green" onClick={() => act(i.id, 'restored', 'Power restored. Thank you.')}>Power restored</button>
            </IncidentCard>
          );
        })}
      </div>
    </>
  );
}
