'use client';
import { useEffect, useState } from 'react';
import { supabase, Profile, ROLE_LABEL, Role } from '@/lib/supabase';
import { post } from '@/lib/api';

type Ward = { id: string; municipality: string; name: string };
type Village = { id: number; name: string; ward_id: string };
type Transformer = { id: string; name: string | null; village_id: number; lat: number; lng: number; capacity_kva: number | null };
type Staff = { id: string; role: Role; display_name: string; staff_number: string | null; ward_id: string | null; status: string };

const TABS = ['Areas and transformers', 'Staff accounts'] as const;

export default function AdminDashboard({ profile }: { profile: Profile }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Areas and transformers');
  const [wards, setWards] = useState<Ward[]>([]);
  const [villages, setVillages] = useState<Village[]>([]);
  const [tx, setTx] = useState<Transformer[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const isSys = profile.role === 'system_admin';

  const load = () => {
    supabase.from('wards').select('*').order('id').then(({ data }) => setWards(data || []));
    supabase.from('villages').select('*').order('name').then(({ data }) => setVillages(data || []));
    supabase.from('transformers').select('*').order('id').then(({ data }) => setTx(data || []));
    supabase.from('profiles').select('*').order('role').then(({ data }) => setStaff((data as Staff[]) || []));
  };
  useEffect(load, []);

  const done = (error: { message: string } | null, ok: string) => { if (error) setMsg({ err: error.message }); else { setMsg({ ok }); load(); } };

  return (
    <>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (<button key={t} role="tab" className="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t}</button>))}
      </div>
      {msg.ok && <div className="ok">{msg.ok}</div>}
      {msg.err && <div className="error">{msg.err}</div>}

      {tab === 'Areas and transformers' && (
        <div className="grid c2" style={{ alignItems: 'start' }}>
          <div className="grid">
            <div className="table-wrap"><table>
              <thead><tr><th>Ward</th><th>Municipality</th><th>Villages</th></tr></thead>
              <tbody>{wards.map((w) => (<tr key={w.id}><td>{w.id}<br /><span className="muted">{w.name}</span></td><td>{w.municipality}</td><td>{villages.filter((v) => v.ward_id === w.id).map((v) => v.name).join(', ')}</td></tr>))}</tbody>
            </table></div>
            <div className="table-wrap"><table>
              <thead><tr><th>Transformer</th><th>Village</th><th>kVA</th><th>Location</th></tr></thead>
              <tbody>{tx.map((t) => (<tr key={t.id}><td>{t.id}<br /><span className="muted">{t.name}</span></td><td>{villages.find((v) => v.id === t.village_id)?.name}</td><td>{t.capacity_kva}</td><td>{t.lat.toFixed(4)}, {t.lng.toFixed(4)}</td></tr>))}</tbody>
            </table></div>
          </div>
          <div className="grid">
            <Form title="Add ward" fields={[['id', 'Ward ID (e.g. THULAMELA-W30)'], ['municipality', 'Municipality'], ['name', 'Name']]}
              onSubmit={async (v) => { const { error } = await supabase.from('wards').insert(v); done(error, 'Ward added.'); }} />
            <Form title="Add village" fields={[['name', 'Village name']]} select={{ key: 'ward_id', label: 'Ward', options: wards.map((w) => [w.id, w.id]) }}
              onSubmit={async (v) => { const { error } = await supabase.from('villages').insert(v); done(error, 'Village added.'); }} />
            <Form title="Add transformer" fields={[['id', 'Eskom asset number'], ['name', 'Name'], ['lat', 'Latitude'], ['lng', 'Longitude'], ['capacity_kva', 'Capacity (kVA)']]}
              select={{ key: 'village_id', label: 'Village', options: villages.map((v) => [String(v.id), v.name]) }}
              onSubmit={async (v) => {
                const { error } = await supabase.from('transformers').insert({ ...v, village_id: Number(v.village_id), lat: Number(v.lat), lng: Number(v.lng), capacity_kva: v.capacity_kva ? Number(v.capacity_kva) : null });
                done(error, 'Transformer added.');
              }} />
          </div>
        </div>
      )}

      {tab === 'Staff accounts' && (
        <div className="grid c2" style={{ alignItems: 'start' }}>
          <div className="table-wrap"><table>
            <thead><tr><th>Name</th><th>Role</th><th>Staff no.</th><th>Ward</th><th>Status</th></tr></thead>
            <tbody>{staff.map((s) => (
              <tr key={s.id}><td>{s.display_name}</td><td>{ROLE_LABEL[s.role]}</td><td>{s.staff_number}</td><td>{s.ward_id}</td>
                <td>{isSys && s.id !== profile.id ? (
                  <button className="btn light sm" onClick={async () => {
                    const { error } = await supabase.from('profiles').update({ status: s.status === 'active' ? 'disabled' : 'active' }).eq('id', s.id);
                    done(error, 'Account updated.');
                  }}>{s.status === 'active' ? 'Disable' : 'Enable'}</button>
                ) : s.status}</td></tr>
            ))}</tbody>
          </table></div>
          {isSys ? (
            <Form title="Create staff account" fields={[['email', 'Work email'], ['password', 'Temporary password (12+ characters)'], ['display_name', 'Full name'], ['staff_number', 'Staff or councillor number'], ['ward_id', 'Ward ID (councillors only)']]}
              select={{ key: 'role', label: 'Role', options: Object.entries(ROLE_LABEL) }}
              onSubmit={async (v) => {
                try { await post('/admin/users', { ...v, ward_id: v.ward_id || undefined, staff_number: v.staff_number || undefined }); setMsg({ ok: 'Account created.' }); load(); }
                catch (e) { setMsg({ err: (e as Error).message }); }
              }} />
          ) : <div className="card muted">Only the system admin can create staff accounts.</div>}
        </div>
      )}
    </>
  );
}

function Form({ title, fields, select, onSubmit }: {
  title: string; fields: [string, string][]; select?: { key: string; label: string; options: [string, string][] };
  onSubmit: (v: Record<string, string>) => Promise<void>;
}) {
  const [v, setV] = useState<Record<string, string>>({});
  return (
    <form className="card" onSubmit={async (e) => { e.preventDefault(); await onSubmit(v); setV({}); }}>
      <h3>{title}</h3>
      {select && (
        <div className="field"><label htmlFor={`${title}-${select.key}`}>{select.label}</label>
          <select id={`${title}-${select.key}`} required value={v[select.key] || ''} onChange={(e) => setV({ ...v, [select.key]: e.target.value })}>
            <option value="">Choose</option>{select.options.map(([k, l]) => (<option key={k} value={k}>{l}</option>))}
          </select></div>
      )}
      {fields.map(([k, l]) => (
        <div className="field" key={k}><label htmlFor={`${title}-${k}`}>{l}</label>
          <input id={`${title}-${k}`} type={k === 'password' ? 'password' : 'text'} required={!['capacity_kva', 'ward_id', 'staff_number'].includes(k)}
            value={v[k] || ''} onChange={(e) => setV({ ...v, [k]: e.target.value })} /></div>
      ))}
      <button className="btn">Save</button>
    </form>
  );
}
