'use client';
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { post } from '@/lib/api';
import { rand, BillingSettings } from './Billing';
import { TYPE_LABEL } from './IncidentCard';

export type Category = 'subscription' | 'hardware' | 'service' | 'stolen_item' | 'repair' | 'other';
export type CatalogItem = { id: number; category: Category; name: string; unit: string; unit_price: number; vat_applies: boolean; note: string | null; active: boolean };
type Line = { key: number; description: string; category: Category; unit: string; quantity: number; unit_price: number; vat_applies: boolean };
type IncidentOpt = { id: string; transformer_id: string; type: string; status: string; created_at: string; saps_escort: boolean; transformers: { name: string | null } | null };

export const CATEGORY_LABEL: Record<Category, string> = {
  stolen_item: 'Stolen or lost items', repair: 'Repairs', service: 'Services and labour',
  hardware: 'Sensors and hardware', subscription: 'Subscription', other: 'Other',
};

// What you will probably need on the invoice, by type of incident
const SUGGEST: Record<string, { name: string; quantity: number; why: string }[]> = {
  CABLE_CUT: [
    { name: 'Copper cable', quantity: 30, why: 'Measure the length taken on site' },
    { name: 'Emergency site call-out', quantity: 1, why: 'Crew sent out after the alert' },
    { name: 'Technician labour', quantity: 4, why: 'Typical time to re-run and joint cable' },
    { name: 'Cable jointing and reconnection', quantity: 2, why: 'One joint at each cut end' },
    { name: 'Travel to site', quantity: 60, why: 'Return trip in km from the depot' },
    { name: 'Report and evidence pack for SAPS or insurer', quantity: 1, why: 'Needed to open a theft case' },
  ],
  BOX_OPENED: [
    { name: 'Enclosure or box door repair', quantity: 1, why: 'The door or lock was forced' },
    { name: 'Transformer oil', quantity: 50, why: 'Check if oil was drained' },
    { name: 'Replacement sensor kit (stolen or damaged)', quantity: 1, why: 'If the sensor was taken' },
    { name: 'Emergency site call-out', quantity: 1, why: 'Crew sent out after the alert' },
    { name: 'Technician labour', quantity: 2, why: 'Inspect, secure and test' },
    { name: 'Report and evidence pack for SAPS or insurer', quantity: 1, why: 'Needed to open a case' },
  ],
  SENSOR_SILENT: [
    { name: 'Replacement sensor kit (stolen or damaged)', quantity: 1, why: 'Silent sensors are often smashed or stolen' },
    { name: 'Emergency site call-out', quantity: 1, why: 'Site visit to check the unit' },
    { name: 'Technician labour', quantity: 2, why: 'Fit and test the new unit' },
    { name: 'Travel to site', quantity: 60, why: 'Return trip in km from the depot' },
  ],
  VIBRATION: [
    { name: 'Emergency site call-out', quantity: 1, why: 'Check for attempted theft' },
    { name: 'Overnight site security', quantity: 2, why: 'Guard a site under repeated attack' },
    { name: 'Fence or palisade repair', quantity: 10, why: 'If the fence was cut' },
  ],
  POWER_DROP: [
    { name: 'Emergency site call-out', quantity: 1, why: 'Crew sent out after the alert' },
    { name: 'Technician labour', quantity: 2, why: 'Find and fix the fault' },
    { name: 'Travel to site', quantity: 60, why: 'Return trip in km from the depot' },
  ],
};
const GENERAL = [
  { name: 'Transformer (average loss, Limpopo 2022-23)', quantity: 1, why: 'Only if the whole transformer was stolen' },
  { name: 'Overnight site security', quantity: 1, why: 'Protect the site until it is repaired' },
];

let nextKey = 1;

export default function InvoiceWriter({ settings, onCreated }: { settings: BillingSettings | null; onCreated: (msg: { ok?: string; err?: string }) => void }) {
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [incidents, setIncidents] = useState<IncidentOpt[]>([]);
  const [incidentId, setIncidentId] = useState('');
  const [title, setTitle] = useState('');
  const [customer, setCustomer] = useState('');
  const [sapsCase, setSapsCase] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [discount, setDiscount] = useState(0);
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.from('invoice_catalog').select('*').eq('active', true).order('category').order('name').then(({ data }) => setCatalog((data as CatalogItem[]) || []));
    supabase.from('incidents').select('id, transformer_id, type, status, created_at, saps_escort, transformers(name)')
      .order('created_at', { ascending: false }).limit(50).then(({ data }) => setIncidents((data as unknown as IncidentOpt[]) || []));
  }, []);

  const incident = incidents.find((i) => i.id === incidentId);
  const vatRate = Number(settings?.vat_rate ?? 0.15);

  // Live totals (the database recalculates the same way when you save)
  const t = useMemo(() => {
    const amt = (l: Line) => Math.round(l.quantity * l.unit_price * 100) / 100;
    const sub = lines.reduce((a, l) => a + amt(l), 0);
    const vatable = lines.filter((l) => l.vat_applies).reduce((a, l) => a + amt(l), 0);
    const loss = lines.filter((l) => l.category === 'stolen_item').reduce((a, l) => a + amt(l), 0);
    const disc = Math.min(Math.max(discount || 0, 0), sub);
    const vat = sub ? Math.round((vatable - (disc * vatable) / sub) * vatRate * 100) / 100 : 0;
    return { amt, sub, disc, vat, loss, total: sub - disc + vat };
  }, [lines, discount, vatRate]);

  function addFromCatalog(name: string, quantity = 1) {
    const c = catalog.find((x) => x.name === name);
    if (!c) return;
    setLines((ls) => [...ls, { key: nextKey++, description: c.name, category: c.category, unit: c.unit, quantity, unit_price: Number(c.unit_price), vat_applies: c.vat_applies }]);
  }
  function addBlank() {
    setLines((ls) => [...ls, { key: nextKey++, description: '', category: 'other', unit: 'each', quantity: 1, unit_price: 0, vat_applies: true }]);
  }
  const update = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const remove = (key: number) => setLines((ls) => ls.filter((l) => l.key !== key));

  function pickIncident(id: string) {
    setIncidentId(id);
    const inc = incidents.find((i) => i.id === id);
    if (inc && !title) setTitle(`${TYPE_LABEL[inc.type] || inc.type} at ${inc.transformer_id} ${inc.transformers?.name || ''}`.trim());
  }

  const suggestions = [...(incident ? SUGGEST[incident.type] || [] : []), ...GENERAL]
    .filter((s) => catalog.some((c) => c.name === s.name) && !lines.some((l) => l.description === s.name));

  async function save() {
    setBusy(true);
    const extra = [sapsCase && `SAPS case number: ${sapsCase}`, poNumber && `Purchase order: ${poNumber}`, notes].filter(Boolean).join('\n');
    try {
      await post('/billing/manual-invoices', {
        title, incident_id: incidentId || null, customer_name: customer || undefined, discount: t.disc, notes: extra || undefined,
        lines: lines.map(({ key: _k, ...l }) => ({ ...l, quantity: Number(l.quantity), unit_price: Number(l.unit_price) })),
      });
      onCreated({ ok: 'Draft invoice created. Find it in the list below, then View and Issue it.' });
      setLines([]); setTitle(''); setIncidentId(''); setNotes(''); setSapsCase(''); setPoNumber(''); setDiscount(0); setCustomer('');
    } catch (e) {
      onCreated({ err: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const grouped = (Object.keys(CATEGORY_LABEL) as Category[]).map((c) => [c, catalog.filter((x) => x.category === c)] as const).filter(([, xs]) => xs.length);

  return (
    <div className="grid">
      <div className="grid c2" style={{ alignItems: 'start' }}>
        <div className="card">
          <h3>1. What is this invoice for?</h3>
          <div className="field"><label htmlFor="w-inc">Link to an incident (optional)</label>
            <select id="w-inc" value={incidentId} onChange={(e) => pickIncident(e.target.value)}>
              <option value="">No incident</option>
              {incidents.map((i) => (
                <option key={i.id} value={i.id}>
                  {new Date(i.created_at).toLocaleDateString('en-ZA')} . {TYPE_LABEL[i.type] || i.type} . {i.transformer_id} {i.transformers?.name || ''} . {i.status}
                </option>
              ))}
            </select></div>
          <div className="field"><label htmlFor="w-title">Invoice title</label>
            <input id="w-title" required value={title} placeholder="e.g. Cable theft at TX-VH-1002 Midoroni School" onChange={(e) => setTitle(e.target.value)} /></div>
          <div className="field"><label htmlFor="w-cust">Bill to (leave empty for {settings?.customer_name || 'the default customer'})</label>
            <input id="w-cust" value={customer} onChange={(e) => setCustomer(e.target.value)} /></div>
          <div className="row">
            <div className="field" style={{ flex: 1 }}><label htmlFor="w-saps">SAPS case number</label><input id="w-saps" value={sapsCase} onChange={(e) => setSapsCase(e.target.value)} /></div>
            <div className="field" style={{ flex: 1 }}><label htmlFor="w-po">Eskom purchase order</label><input id="w-po" value={poNumber} onChange={(e) => setPoNumber(e.target.value)} /></div>
          </div>
        </div>

        <div className="card">
          <h3>2. Suggested for {incident ? (TYPE_LABEL[incident.type] || incident.type).toLowerCase() : 'this invoice'}</h3>
          {!incident && <p className="muted">Link an incident to get suggestions that fit what happened.</p>}
          <div className="grid">
            {suggestions.map((s) => {
              const c = catalog.find((x) => x.name === s.name)!;
              return (
                <div key={s.name} className="row" style={{ justifyContent: 'space-between', borderBottom: '1px solid var(--line)', paddingBottom: '.4rem' }}>
                  <div>
                    <strong>{s.name}</strong> <span className="muted">{s.quantity} {c.unit} x {rand(c.unit_price)}</span>
                    <div className="muted" style={{ fontSize: '.85rem' }}>{s.why}</div>
                  </div>
                  <button type="button" className="btn amber sm" onClick={() => addFromCatalog(s.name, s.quantity)}>Add</button>
                </div>
              );
            })}
            {!suggestions.length && <p className="muted">All suggestions added.</p>}
          </div>
        </div>
      </div>

      <div className="card">
        <h3>3. Lines</h3>
        <div className="row" style={{ marginBottom: '.75rem' }}>
          <select aria-label="Add from price list" value="" onChange={(e) => { if (e.target.value) addFromCatalog(e.target.value); }} style={{ maxWidth: 420 }}>
            <option value="">+ Add from price list</option>
            {grouped.map(([cat, xs]) => (
              <optgroup key={cat} label={CATEGORY_LABEL[cat]}>
                {xs.map((x) => (<option key={x.id} value={x.name}>{x.name} ({rand(x.unit_price)} / {x.unit})</option>))}
              </optgroup>
            ))}
          </select>
          <button type="button" className="btn light" onClick={addBlank}>+ Blank line</button>
        </div>
        <div className="table-wrap" style={{ border: 0 }}>
          <table>
            <thead><tr><th style={{ minWidth: 220 }}>Description</th><th>Type</th><th>Qty</th><th>Unit</th><th>Unit price (R)</th><th>VAT</th><th style={{ textAlign: 'right' }}>Amount</th><th></th></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key}>
                  <td><input aria-label="Description" value={l.description} onChange={(e) => update(l.key, { description: e.target.value })} /></td>
                  <td><select aria-label="Type" value={l.category} onChange={(e) => update(l.key, { category: e.target.value as Category, vat_applies: e.target.value === 'stolen_item' ? false : l.vat_applies })}>
                    {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => (<option key={c} value={c}>{CATEGORY_LABEL[c]}</option>))}
                  </select></td>
                  <td><input aria-label="Quantity" type="number" min="0" step="any" style={{ width: 90 }} value={l.quantity} onChange={(e) => update(l.key, { quantity: Number(e.target.value) })} /></td>
                  <td><input aria-label="Unit" style={{ width: 100 }} value={l.unit} onChange={(e) => update(l.key, { unit: e.target.value })} /></td>
                  <td><input aria-label="Unit price" type="number" min="0" step="0.01" style={{ width: 130 }} value={l.unit_price} onChange={(e) => update(l.key, { unit_price: Number(e.target.value) })} /></td>
                  <td><input aria-label="VAT applies" type="checkbox" style={{ width: 'auto' }} checked={l.vat_applies} onChange={(e) => update(l.key, { vat_applies: e.target.checked })} /></td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{rand(t.amt(l))}</td>
                  <td><button type="button" className="btn light sm" aria-label={`Remove ${l.description}`} onClick={() => remove(l.key)}>Remove</button></td>
                </tr>
              ))}
              {!lines.length && <tr><td colSpan={8} className="muted">No lines yet. Add suggestions above or pick from the price list.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid c2" style={{ alignItems: 'start' }}>
        <div className="card">
          <h3>4. Notes</h3>
          <textarea aria-label="Notes" rows={4} value={notes} placeholder="What happened, what was replaced, who attended" onChange={(e) => setNotes(e.target.value)} />
          <p className="muted" style={{ fontSize: '.85rem' }}>
            Tips: stolen items are usually claimed as a loss with no VAT; work and parts carry VAT. Measure stolen cable on site and add photos to the SAPS case. Check VAT treatment with your accountant.
          </p>
        </div>
        <div className="card">
          <h3>5. Totals (calculated automatically)</h3>
          <table>
            <tbody>
              <tr><td>Subtotal</td><td style={{ textAlign: 'right' }}>{rand(t.sub)}</td></tr>
              <tr><td><label htmlFor="w-disc" style={{ display: 'inline' }}>Discount (R)</label></td>
                <td style={{ textAlign: 'right' }}><input id="w-disc" type="number" min="0" step="0.01" style={{ width: 140 }} value={discount} onChange={(e) => setDiscount(Number(e.target.value))} /></td></tr>
              <tr><td>VAT ({Math.round(vatRate * 10000) / 100}% on taxable lines)</td><td style={{ textAlign: 'right' }}>{rand(t.vat)}</td></tr>
              <tr><td><strong>Total due</strong></td><td style={{ textAlign: 'right' }}><strong style={{ fontSize: '1.3rem' }}>{rand(t.total)}</strong></td></tr>
              {t.loss > 0 && <tr><td className="muted">Of which value of stolen items</td><td className="muted" style={{ textAlign: 'right' }}>{rand(t.loss)}</td></tr>}
            </tbody>
          </table>
          <button className="btn big" style={{ marginTop: '1rem' }} disabled={busy || !lines.length || title.trim().length < 2}
            onClick={save}>{busy ? 'Saving...' : 'Create draft invoice'}</button>
        </div>
      </div>
    </div>
  );
}

export function PriceList({ onMsg }: { onMsg: (m: { ok?: string; err?: string }) => void }) {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [form, setForm] = useState({ category: 'stolen_item' as Category, name: '', unit: 'each', unit_price: '', vat_applies: false });
  const load = () => supabase.from('invoice_catalog').select('*').order('category').order('name').then(({ data }) => setItems((data as CatalogItem[]) || []));
  useEffect(() => { load(); }, []);

  async function setPrice(i: CatalogItem, price: string) {
    const { error } = await supabase.from('invoice_catalog').update({ unit_price: Number(price) }).eq('id', i.id);
    if (error) onMsg({ err: error.message }); else { onMsg({ ok: `${i.name} price updated.` }); load(); }
  }

  return (
    <div className="grid c2" style={{ alignItems: 'start' }}>
      <div className="table-wrap"><table>
        <thead><tr><th>Item</th><th>Type</th><th>Unit</th><th>Price (R)</th><th>VAT</th><th></th></tr></thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id} style={{ opacity: i.active ? 1 : 0.5 }}>
              <td>{i.name}{i.note && <div className="muted" style={{ fontSize: '.8rem' }}>{i.note}</div>}</td>
              <td>{CATEGORY_LABEL[i.category]}</td><td>{i.unit}</td>
              <td><input aria-label={`Price for ${i.name}`} type="number" step="0.01" min="0" style={{ width: 120 }} defaultValue={i.unit_price}
                onBlur={(e) => { if (Number(e.target.value) !== Number(i.unit_price)) setPrice(i, e.target.value); }} /></td>
              <td>{i.vat_applies ? 'Yes' : 'No'}</td>
              <td><button className="btn light sm" onClick={async () => {
                const { error } = await supabase.from('invoice_catalog').update({ active: !i.active }).eq('id', i.id);
                if (error) onMsg({ err: error.message }); else load();
              }}>{i.active ? 'Hide' : 'Show'}</button></td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <form className="card" onSubmit={async (e) => {
        e.preventDefault();
        const { error } = await supabase.from('invoice_catalog').insert({ ...form, unit_price: Number(form.unit_price) });
        if (error) onMsg({ err: error.message }); else { onMsg({ ok: 'Item added to the price list.' }); setForm({ ...form, name: '', unit_price: '' }); load(); }
      }}>
        <h3>Add an item</h3>
        <p className="muted">Prices marked &quot;Estimate&quot; are starting points. Replace them with real quotes before invoicing.</p>
        <div className="field"><label htmlFor="pl-c">Type</label>
          <select id="pl-c" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as Category, vat_applies: e.target.value !== 'stolen_item' })}>
            {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => (<option key={c} value={c}>{CATEGORY_LABEL[c]}</option>))}
          </select></div>
        <div className="field"><label htmlFor="pl-n">Name</label><input id="pl-n" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
        <div className="row">
          <div className="field" style={{ flex: 1 }}><label htmlFor="pl-u">Unit</label><input id="pl-u" required value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} /></div>
          <div className="field" style={{ flex: 1 }}><label htmlFor="pl-p">Price (R)</label><input id="pl-p" type="number" step="0.01" min="0" required value={form.unit_price} onChange={(e) => setForm({ ...form, unit_price: e.target.value })} /></div>
        </div>
        <label style={{ display: 'flex', gap: '.5rem', alignItems: 'center', marginBottom: '.9rem' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={form.vat_applies} onChange={(e) => setForm({ ...form, vat_applies: e.target.checked })} /> VAT applies
        </label>
        <button className="btn">Add item</button>
      </form>
    </div>
  );
}
