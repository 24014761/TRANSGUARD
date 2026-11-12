'use client';
import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { supabase, Profile } from '@/lib/supabase';
import { post, api, downloadCsv, ago } from '@/lib/api';
import { useIncidents } from './hooks';
import IncidentCard, { TYPE_LABEL } from './IncidentCard';
import type { MapPoint } from './MapView';

const MapView = dynamic(() => import('./MapView'), { ssr: false, loading: () => <div className="map" /> });

type Kpis = Record<string, number | null>;
type Transformer = { id: string; name: string | null; lat: number; lng: number; village_id: number; villages?: { name: string; ward_id: string } };
type Device = { id: string; transformer_id: string; status: string; last_heartbeat: string | null; battery_pct: number | null; firmware: string | null; last_seq: number };
type Reading = { device_id: string; ts: string; current_a: number | null; voltage_v: number | null; vibration_g: number | null; temp_c: number | null; box_open: boolean | null; motion: boolean | null; cable_cut: boolean | null };

const TABS = ['Overview', 'Alerts and map', 'Sensors', 'Load-shedding', 'Security and records'] as const;

export default function OperatorDashboard({ profile }: { profile: Profile }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Overview');
  const { items: open, reload } = useIncidents('open');
  const { items: all } = useIncidents('all');
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [transformers, setTransformers] = useState<Transformer[]>([]);
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const [busy, setBusy] = useState('');

  useEffect(() => {
    api<Kpis>('/reports/kpis').then(setKpis).catch(() => setKpis(null));
    supabase.from('transformers').select('*, villages(name, ward_id)').order('id').then(({ data }) => setTransformers((data as Transformer[]) || []));
  }, [open.length, all.length]);

  async function act(id: string, path: string, label: string) {
    setBusy(id + path);
    setMsg({});
    try {
      await post(`/incidents/${id}/${path}`);
      setMsg({ ok: label });
      reload();
    } catch (e) {
      setMsg({ err: (e as Error).message });
    } finally {
      setBusy('');
    }
  }

  const points: MapPoint[] = useMemo(() => {
    const byT = new Map(open.map((i) => [i.transformer_id, i]));
    return transformers.map((t) => {
      const inc = byT.get(t.id);
      return { id: t.id, name: t.name || t.id, lat: t.lat, lng: t.lng, confidence: inc?.confidence, status: inc?.status };
    });
  }, [open, transformers]);

  const byVillage = useMemo(() => {
    const m: Record<string, number> = {};
    all.forEach((i) => { const v = i.transformers?.villages?.name || i.transformer_id; m[v] = (m[v] || 0) + 1; });
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [all]);

  return (
    <>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (<button key={t} role="tab" className="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t}</button>))}
      </div>
      {msg.ok && <div className="ok" role="status">{msg.ok}</div>}
      {msg.err && <div className="error" role="alert">{msg.err}</div>}

      {tab === 'Overview' && (
        <>
          <div className="grid c4">
            <Kpi l="Open alerts" v={kpis?.open_incidents} />
            <Kpi l="Waiting for councillor" v={kpis?.verifying} />
            <Kpi l="Avg minutes to dispatch" v={kpis?.avg_minutes_to_dispatch} />
            <Kpi l="Confirmed outages" v={kpis?.confirmed_outages} />
            <Kpi l="False trips avoided" v={kpis?.false_trips_avoided} />
            <Kpi l="Restored" v={kpis?.restored} />
            <Kpi l="Transformers" v={kpis?.transformers} />
            <Kpi l="Sensors online / silent" v={kpis ? `${kpis.devices_online} / ${kpis.devices_silent}` : undefined} />
          </div>
          <div className="grid c2" style={{ marginTop: '1rem' }}>
            <div className="card">
              <h3>Incidents by village</h3>
              {byVillage.map(([v, n]) => (
                <div key={v} style={{ margin: '.35rem 0' }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}><span>{v}</span><strong>{n}</strong></div>
                  <div style={{ height: 8, background: '#eef2f6', borderRadius: 4 }}>
                    <div style={{ height: 8, width: `${(n / (byVillage[0]?.[1] || 1)) * 100}%`, background: 'var(--brand)', borderRadius: 4 }} />
                  </div>
                </div>
              ))}
              {!byVillage.length && <p className="muted">No incidents yet.</p>}
            </div>
            <div className="card">
              <h3>Reports</h3>
              <p className="muted">Export every incident with its timeline (response times, false alarms, outages per ward).</p>
              <button className="btn" onClick={() => downloadCsv().catch((e) => setMsg({ err: e.message }))}>Download CSV</button>
            </div>
          </div>
        </>
      )}

      {tab === 'Alerts and map' && (
        <div className="grid c2" style={{ alignItems: 'start' }}>
          <div className="grid">
            <ManualIncident transformers={transformers} onDone={(m) => { setMsg(m); reload(); }} />
            {open.length === 0 && <div className="card muted">No open alerts.</div>}
            {open.map((i) => (
              <IncidentCard key={i.id} incident={i}>
                {i.status === 'NEW' && <button className="btn amber sm" disabled={!!busy} onClick={() => act(i.id, 'ask-verification', 'Councillor asked to confirm.')}>Ask councillor</button>}
                {(i.status === 'NEW' || i.status === 'VERIFYING') && <button className="btn light sm" disabled={!!busy} onClick={() => act(i.id, 'dispatch', 'Crew dispatched (Eskom override).')}>Dispatch now</button>}
                {i.status === 'DISPATCHED' && <button className="btn sm" disabled={!!busy} onClick={() => act(i.id, 'arrived', 'Marked on site.')}>Mark on site</button>}
                {(i.status === 'DISPATCHED' || i.status === 'ON_SITE') && <button className="btn green sm" disabled={!!busy} onClick={() => act(i.id, 'restored', 'Marked restored.')}>Mark restored</button>}
              </IncidentCard>
            ))}
          </div>
          <div style={{ position: 'sticky', top: 12 }}><MapView points={points} /></div>
        </div>
      )}

      {tab === 'Sensors' && <Sensors transformers={transformers} />}
      {tab === 'Load-shedding' && <LoadShedding canEdit={profile.role === 'eskom_operator' || profile.role === 'system_admin'} />}
      {tab === 'Security and records' && <Records />}
    </>
  );
}

function Kpi({ l, v }: { l: string; v: number | string | null | undefined }) {
  return <div className="kpi"><div className="v">{v ?? '-'}</div><div className="l">{l}</div></div>;
}

function ManualIncident({ transformers, onDone }: { transformers: Transformer[]; onDone: (m: { ok?: string; err?: string }) => void }) {
  const [t, setT] = useState('');
  const [type, setType] = useState('POWER_DROP');
  return (
    <form className="card" onSubmit={async (e) => {
      e.preventDefault();
      try {
        const r = await post<{ id: string | null; filtered: boolean }>('/incidents', { transformer_id: t, type });
        onDone(r.filtered ? { ok: 'Filtered: this village is in a load-shedding slot, so no incident was created.' } : { ok: 'Incident logged.' });
      } catch (err) { onDone({ err: (err as Error).message }); }
    }}>
      <h3>Log a fault manually</h3>
      <div className="row">
        <select aria-label="Transformer" required value={t} onChange={(e) => setT(e.target.value)} style={{ flex: 2 }}>
          <option value="">Choose transformer</option>
          {transformers.map((x) => (<option key={x.id} value={x.id}>{x.id} {x.name}</option>))}
        </select>
        <select aria-label="Fault type" value={type} onChange={(e) => setType(e.target.value)} style={{ flex: 1 }}>
          {Object.entries(TYPE_LABEL).map(([k, v]) => (<option key={k} value={k}>{v}</option>))}
        </select>
        <button className="btn">Log</button>
      </div>
    </form>
  );
}

function Sensors({ transformers }: { transformers: Transformer[] }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [sel, setSel] = useState('');
  const [readings, setReadings] = useState<Reading[]>([]);
  useEffect(() => {
    const load = () => supabase.from('devices').select('*').order('id').then(({ data }) => setDevices((data as Device[]) || []));
    load();
    const ch = supabase.channel('devices-live').on('postgres_changes', { event: '*', schema: 'public', table: 'devices' }, load).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);
  useEffect(() => {
    if (sel) api<Reading[]>(`/transformers/${sel}/readings`).then(setReadings).catch(() => setReadings([]));
  }, [sel]);
  const tName = (id: string) => transformers.find((t) => t.id === id)?.name || '';
  return (
    <div className="grid">
      <div className="table-wrap">
        <table>
          <thead><tr><th>Device</th><th>Transformer</th><th>Status</th><th>Last heartbeat</th><th>Battery</th><th>Firmware</th><th></th></tr></thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id}>
                <td>{d.id}</td><td>{d.transformer_id} {tName(d.transformer_id)}</td>
                <td><span className={`dot ${d.status === 'online' ? 'on' : 'off'}`} />{d.status}</td>
                <td>{d.last_heartbeat ? ago(d.last_heartbeat) : 'never'}</td>
                <td>{d.battery_pct ?? '-'}%</td><td>{d.firmware}</td>
                <td><button className="btn light sm" onClick={() => setSel(d.transformer_id)}>Readings</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sel && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Time ({sel})</th><th>Current A</th><th>Voltage V</th><th>Vibration g</th><th>Temp C</th><th>Box</th><th>Motion</th><th>Cable</th></tr></thead>
            <tbody>
              {readings.map((r) => (
                <tr key={r.device_id + r.ts}>
                  <td>{new Date(r.ts).toLocaleString('en-ZA')}</td><td>{r.current_a ?? '-'}</td><td>{r.voltage_v ?? '-'}</td>
                  <td>{r.vibration_g ?? '-'}</td><td>{r.temp_c ?? '-'}</td><td>{r.box_open ? 'OPEN' : 'closed'}</td>
                  <td>{r.motion ? 'yes' : 'no'}</td><td>{r.cable_cut ? 'CUT' : 'ok'}</td>
                </tr>
              ))}
              {!readings.length && <tr><td colSpan={8} className="muted">No readings yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

type Slot = { id: number; village_id: number; starts_at: string; ends_at: string; villages?: { name: string } };
function LoadShedding({ canEdit }: { canEdit: boolean }) {
  const [slots, setSlots] = useState<Slot[]>([]);
  const [villages, setVillages] = useState<{ id: number; name: string }[]>([]);
  const [form, setForm] = useState({ village_id: '', starts_at: '', ends_at: '' });
  const [err, setErr] = useState('');
  const load = () => supabase.from('loadshedding_slots').select('*, villages(name)').gte('ends_at', new Date(Date.now() - 864e5).toISOString()).order('starts_at').then(({ data }) => setSlots((data as Slot[]) || []));
  useEffect(() => {
    load();
    supabase.from('villages').select('id, name').order('name').then(({ data }) => setVillages(data || []));
  }, []);
  return (
    <div className="grid c2" style={{ alignItems: 'start' }}>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Village</th><th>Starts</th><th>Ends</th></tr></thead>
          <tbody>
            {slots.map((s) => (<tr key={s.id}><td>{s.villages?.name}</td><td>{new Date(s.starts_at).toLocaleString('en-ZA')}</td><td>{new Date(s.ends_at).toLocaleString('en-ZA')}</td></tr>))}
            {!slots.length && <tr><td colSpan={3} className="muted">No upcoming slots.</td></tr>}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <form className="card" onSubmit={async (e) => {
          e.preventDefault(); setErr('');
          const { error } = await supabase.from('loadshedding_slots').insert({
            village_id: Number(form.village_id), starts_at: new Date(form.starts_at).toISOString(), ends_at: new Date(form.ends_at).toISOString(),
          });
          if (error) setErr(error.message); else { setForm({ village_id: '', starts_at: '', ends_at: '' }); load(); }
        }}>
          <h3>Add a load-shedding slot</h3>
          <p className="muted">Power drops in this village during the slot are filtered and logged, not raised as incidents.</p>
          {err && <div className="error">{err}</div>}
          <div className="field"><label htmlFor="ls-v">Village</label>
            <select id="ls-v" required value={form.village_id} onChange={(e) => setForm({ ...form, village_id: e.target.value })}>
              <option value="">Choose</option>{villages.map((v) => (<option key={v.id} value={v.id}>{v.name}</option>))}
            </select></div>
          <div className="field"><label htmlFor="ls-s">Starts</label><input id="ls-s" type="datetime-local" required value={form.starts_at} onChange={(e) => setForm({ ...form, starts_at: e.target.value })} /></div>
          <div className="field"><label htmlFor="ls-e">Ends</label><input id="ls-e" type="datetime-local" required value={form.ends_at} onChange={(e) => setForm({ ...form, ends_at: e.target.value })} /></div>
          <button className="btn">Add slot</button>
        </form>
      )}
    </div>
  );
}

type Audit = { id: number; at: string; actor_role: string; action: string; target: string; details: Record<string, unknown> };
type Verif = { id: string; incident_id: string; decision: string; note: string | null; decided_at: string };
function Records() {
  const [audit, setAudit] = useState<Audit[]>([]);
  const [verifs, setVerifs] = useState<Verif[]>([]);
  useEffect(() => {
    supabase.from('audit_log').select('*').order('at', { ascending: false }).limit(150).then(({ data }) => setAudit((data as Audit[]) || []));
    supabase.from('verifications').select('*').order('decided_at', { ascending: false }).limit(50).then(({ data }) => setVerifs((data as Verif[]) || []));
  }, []);
  const blocked = audit.filter((a) => a.action === 'replay_blocked').length;
  return (
    <div className="grid">
      <div className="grid c4">
        <div className="kpi"><div className="v">{blocked}</div><div className="l">Replay attacks blocked (recent)</div></div>
        <div className="kpi"><div className="v">{verifs.length}</div><div className="l">Councillor decisions</div></div>
      </div>
      <h3>Councillor decisions</h3>
      <div className="table-wrap"><table>
        <thead><tr><th>When</th><th>Incident</th><th>Decision</th><th>Note</th></tr></thead>
        <tbody>{verifs.map((v) => (<tr key={v.id}><td>{new Date(v.decided_at).toLocaleString('en-ZA')}</td><td>{v.incident_id.slice(0, 8)}</td><td>{v.decision}</td><td>{v.note}</td></tr>))}</tbody>
      </table></div>
      <h3>Audit log (append-only)</h3>
      <div className="table-wrap"><table>
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Details</th></tr></thead>
        <tbody>{audit.map((a) => (<tr key={a.id}><td>{new Date(a.at).toLocaleString('en-ZA')}</td><td>{a.actor_role}</td><td>{a.action}</td><td>{a.target?.slice(0, 12)}</td><td className="muted">{JSON.stringify(a.details)}</td></tr>))}</tbody>
      </table></div>
    </div>
  );
}
