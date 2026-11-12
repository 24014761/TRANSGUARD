'use client';
import { Incident } from '@/lib/supabase';
import { ago, level } from '@/lib/api';

const STAGES = ['Detected', 'Confirmed', 'Crew sent', 'Restored'];

function stageIndex(i: Incident) {
  if (i.status === 'RESTORED') return 4;
  if (i.status === 'ON_SITE' || i.status === 'DISPATCHED') return 3;
  if (i.verified) return 2;
  return 1;
}

export function nextStep(i: Incident) {
  switch (i.status) {
    case 'NEW': return 'Ask the ward councillor to confirm, or dispatch now if the evidence is strong.';
    case 'VERIFYING': return 'Waiting for the councillor. The job is sent as unverified when the deadline passes.';
    case 'DISPATCHED': return i.saps_escort ? 'Crew is on the way with a SAPS escort request.' : 'Crew is on the way.';
    case 'ON_SITE': return 'Crew is on site. Mark restored when power is back.';
    case 'RESTORED': return 'Closed: power restored.';
    default: return 'Closed: councillor reported power is on (false trip avoided).';
  }
}

export const STATUS_LABEL: Record<string, string> = {
  NEW: 'New', VERIFYING: 'Councillor confirming', DISPATCHED: 'Crew sent', ON_SITE: 'Crew on site',
  RESTORED: 'Restored', CLOSED_FALSE: 'Power on (closed)',
};

export const TYPE_LABEL: Record<string, string> = {
  CABLE_CUT: 'Cable cut', BOX_OPENED: 'Box opened', POWER_DROP: 'Power drop', VIBRATION: 'Vibration',
  SENSOR_SILENT: 'Sensor silent', OTHER: 'Other fault',
};

export default function IncidentCard({ incident: i, children, showHint = true }: { incident: Incident; children?: React.ReactNode; showHint?: boolean }) {
  const lv = level(i.confidence);
  const s = stageIndex(i);
  const t = i.transformers;
  return (
    <article className="card incident" aria-label={`Incident at ${i.transformer_id}`}>
      <div className="head">
        <div>
          <strong>{TYPE_LABEL[i.type] || i.type}</strong> at <strong>{t?.name || i.transformer_id}</strong>
          <div className="meta">
            {i.transformer_id} . {t?.villages?.name || ''} . {i.ward_id} . via {i.source} . {ago(i.created_at)}
          </div>
        </div>
        <div className="row">
          <span className={`badge b-${lv}`}>{lv} {i.confidence}</span>
          <span className={`badge s-${i.status}`}>{STATUS_LABEL[i.status]}</span>
          {i.verified === false && i.status !== 'CLOSED_FALSE' && <span className="badge b-HIGH">UNVERIFIED</span>}
          {i.saps_escort && <span className="badge b-CRITICAL">SAPS ESCORT</span>}
        </div>
      </div>
      {i.status !== 'CLOSED_FALSE' && (
        <div className="progress" aria-label="Progress">
          {STAGES.map((st, idx) => (<div key={st} className={idx < s ? 'done' : ''}>{st}</div>))}
        </div>
      )}
      {showHint && <div className="hint">{nextStep(i)}</div>}
      {i.signal_count > 1 && <div className="meta">{i.signal_count} signals merged into this incident</div>}
      {children && <div className="row">{children}</div>}
    </article>
  );
}
