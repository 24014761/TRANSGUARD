'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { api, post } from '@/lib/api';

export type Invoice = {
  id: string; number: string; period_start: string; period_end: string; plan: string;
  active_transformers: number; lines: { description: string; quantity: number; unit_price: number; amount: number }[];
  subtotal: number; sla_uptime_pct: number; sla_credit: number; vat: number; total: number;
  status: 'draft' | 'issued' | 'paid' | 'overdue' | 'void';
  issued_at: string | null; due_at: string | null; paid_at: string | null; payment_reference: string | null; notes: string | null;
};

export type BillingSettings = {
  plan: 'pilot' | 'municipal' | 'provincial'; pilot_monthly_fee: number; pilot_max_transformers: number;
  municipal_unit_price: number; provincial_unit_price: number; vat_rate: number; payment_terms_days: number;
  sla_target_pct: number; sla_credit_pct: number; customer_name: string; customer_details: string;
  supplier_name: string; supplier_details: string; bank_details: string;
};

export const rand = (n: number | string) =>
  'R ' + Number(n).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const monthLabel = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' });

const STATUS_CLASS: Record<Invoice['status'], string> = {
  draft: 's-NEW', issued: 's-DISPATCHED', paid: 's-RESTORED', overdue: 'b-CRITICAL', void: 's-CLOSED_FALSE',
};

export function StatusBadge({ s }: { s: Invoice['status'] }) {
  return <span className={`badge ${STATUS_CLASS[s]}`}>{s.toUpperCase()}</span>;
}

function useInvoices() {
  const [items, setItems] = useState<Invoice[]>([]);
  const [err, setErr] = useState('');
  const load = () => api<Invoice[]>('/billing/invoices').then(setItems).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  return { items, err, reload: load };
}

function Summary({ items }: { items: Invoice[] }) {
  const open = items.filter((i) => i.status === 'issued' || i.status === 'overdue');
  const paid = items.filter((i) => i.status === 'paid');
  const sum = (xs: Invoice[]) => xs.reduce((a, i) => a + Number(i.total), 0);
  return (
    <div className="grid c4">
      <div className="kpi"><div className="v">{rand(sum(open))}</div><div className="l">Outstanding ({open.length} invoices)</div></div>
      <div className="kpi"><div className="v">{rand(sum(items.filter((i) => i.status === 'overdue')))}</div><div className="l">Overdue</div></div>
      <div className="kpi"><div className="v">{rand(sum(paid))}</div><div className="l">Paid to date</div></div>
      <div className="kpi"><div className="v">{items.filter((i) => i.status === 'draft').length}</div><div className="l">Drafts waiting to be issued</div></div>
    </div>
  );
}

// Read-only list for Eskom operators (the customer)
export function InvoiceList() {
  const { items, err } = useInvoices();
  const visible = items.filter((i) => i.status !== 'draft' && i.status !== 'void');
  return (
    <div className="grid">
      {err && <div className="error">{err}</div>}
      <Summary items={visible} />
      <div className="table-wrap"><table>
        <thead><tr><th>Invoice</th><th>Month</th><th>Active transformers</th><th>Total (incl. VAT)</th><th>Due</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {visible.map((i) => (
            <tr key={i.id}>
              <td>{i.number}</td><td>{monthLabel(i.period_start)}</td><td>{i.active_transformers}</td>
              <td>{rand(i.total)}</td><td>{i.due_at || '-'}</td><td><StatusBadge s={i.status} /></td>
              <td><Link className="btn light sm" href={`/invoice?id=${i.id}`} target="_blank">View / print</Link></td>
            </tr>
          ))}
          {!visible.length && <tr><td colSpan={7} className="muted">No invoices issued yet.</td></tr>}
        </tbody>
      </table></div>
      <p className="muted">Pay by EFT using the invoice number as the reference. Bank details are on each invoice.</p>
    </div>
  );
}

// System admin: settings, generate, issue, mark paid, void
export function BillingAdmin() {
  const { items, err, reload } = useInvoices();
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const [s, setS] = useState<BillingSettings | null>(null);
  const now = new Date();
  const [month, setMonth] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
  const [uptime, setUptime] = useState('100');

  useEffect(() => {
    supabase.from('billing_settings').select('*').eq('id', 1).maybeSingle().then(({ data }) => setS(data as BillingSettings));
  }, []);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setMsg({});
    try { await fn(); setMsg({ ok }); reload(); } catch (e) { setMsg({ err: (e as Error).message }); }
  }

  async function saveSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!s) return;
    const { error } = await supabase.from('billing_settings').update({ ...s, updated_at: new Date().toISOString() }).eq('id', 1);
    setMsg(error ? { err: error.message } : { ok: 'Billing settings saved.' });
  }

  const num = (k: keyof BillingSettings) => ({
    value: String(s?.[k] ?? ''),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setS({ ...(s as BillingSettings), [k]: Number(e.target.value) }),
  });
  const txt = (k: keyof BillingSettings) => ({
    value: String(s?.[k] ?? ''),
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setS({ ...(s as BillingSettings), [k]: e.target.value }),
  });

  return (
    <div className="grid">
      {msg.ok && <div className="ok" role="status">{msg.ok}</div>}
      {(msg.err || err) && <div className="error" role="alert">{msg.err || err}</div>}
      <Summary items={items} />

      <div className="grid c2" style={{ alignItems: 'start' }}>
        <form className="card" onSubmit={(e) => { e.preventDefault(); run(() => post('/billing/invoices', { month, uptime_pct: Number(uptime) }), 'Draft invoice created. Check it, then issue it.'); }}>
          <h3>Create this month&apos;s invoice</h3>
          <p className="muted">Counts every transformer whose sensor reported at least once in the month, applies the plan price, any SLA credit, and VAT.</p>
          <div className="row">
            <div className="field" style={{ flex: 1 }}><label htmlFor="b-m">Month</label><input id="b-m" type="month" required value={month} onChange={(e) => setMonth(e.target.value)} /></div>
            <div className="field" style={{ flex: 1 }}><label htmlFor="b-u">Platform uptime that month (%)</label><input id="b-u" type="number" step="0.001" min="0" max="100" required value={uptime} onChange={(e) => setUptime(e.target.value)} /></div>
          </div>
          <button className="btn">Create draft invoice</button>
        </form>

        {s && (
          <form className="card" onSubmit={saveSettings}>
            <h3>Plan and prices (excl. VAT)</h3>
            <div className="field"><label htmlFor="b-plan">Contract plan</label>
              <select id="b-plan" value={s.plan} onChange={(e) => setS({ ...s, plan: e.target.value as BillingSettings['plan'] })}>
                <option value="pilot">Pilot: flat monthly fee</option>
                <option value="municipal">Municipal: per transformer</option>
                <option value="provincial">Provincial: per transformer</option>
              </select></div>
            <div className="row">
              <div className="field" style={{ flex: 1 }}><label htmlFor="b-pf">Pilot fee (R / month)</label><input id="b-pf" type="number" step="0.01" {...num('pilot_monthly_fee')} /></div>
              <div className="field" style={{ flex: 1 }}><label htmlFor="b-pm">Pilot limit (transformers)</label><input id="b-pm" type="number" {...num('pilot_max_transformers')} /></div>
            </div>
            <div className="row">
              <div className="field" style={{ flex: 1 }}><label htmlFor="b-mu">Municipal (R / transformer)</label><input id="b-mu" type="number" step="0.01" {...num('municipal_unit_price')} /></div>
              <div className="field" style={{ flex: 1 }}><label htmlFor="b-pu">Provincial (R / transformer)</label><input id="b-pu" type="number" step="0.01" {...num('provincial_unit_price')} /></div>
            </div>
            <div className="row">
              <div className="field" style={{ flex: 1 }}><label htmlFor="b-vat">VAT rate (0.15 = 15%)</label><input id="b-vat" type="number" step="0.0001" {...num('vat_rate')} /></div>
              <div className="field" style={{ flex: 1 }}><label htmlFor="b-t">Payment terms (days)</label><input id="b-t" type="number" {...num('payment_terms_days')} /></div>
            </div>
            <div className="row">
              <div className="field" style={{ flex: 1 }}><label htmlFor="b-sla">SLA uptime target (%)</label><input id="b-sla" type="number" step="0.001" {...num('sla_target_pct')} /></div>
              <div className="field" style={{ flex: 1 }}><label htmlFor="b-cr">SLA credit (% of fee)</label><input id="b-cr" type="number" step="0.01" {...num('sla_credit_pct')} /></div>
            </div>
            <div className="field"><label htmlFor="b-cn">Customer</label><input id="b-cn" {...txt('customer_name')} /></div>
            <div className="field"><label htmlFor="b-cd">Customer details</label><textarea id="b-cd" rows={2} {...txt('customer_details')} /></div>
            <div className="field"><label htmlFor="b-sn">Your company name</label><input id="b-sn" {...txt('supplier_name')} /></div>
            <div className="field"><label htmlFor="b-sd">Your company details</label><textarea id="b-sd" rows={2} {...txt('supplier_details')} /></div>
            <div className="field"><label htmlFor="b-bd">Bank details for EFT</label><textarea id="b-bd" rows={2} {...txt('bank_details')} /></div>
            <button className="btn">Save settings</button>
          </form>
        )}
      </div>

      <div className="table-wrap"><table>
        <thead><tr><th>Invoice</th><th>Month</th><th>Plan</th><th>Active</th><th>Total (incl. VAT)</th><th>Due</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id}>
              <td>{i.number}</td><td>{monthLabel(i.period_start)}</td><td>{i.plan}</td><td>{i.active_transformers}</td>
              <td>{rand(i.total)}{Number(i.sla_credit) > 0 && <div className="muted">SLA credit {rand(i.sla_credit)}</div>}</td>
              <td>{i.due_at || '-'}</td>
              <td><StatusBadge s={i.status} />{i.payment_reference && <div className="muted">Ref {i.payment_reference}</div>}</td>
              <td><div className="row">
                <Link className="btn light sm" href={`/invoice?id=${i.id}`} target="_blank">View</Link>
                {i.status === 'draft' && <button className="btn amber sm" onClick={() => run(() => post(`/billing/invoices/${i.id}/issue`), `${i.number} issued to Eskom.`)}>Issue</button>}
                {(i.status === 'issued' || i.status === 'overdue') && <button className="btn green sm" onClick={() => {
                  const ref = window.prompt(`EFT reference or proof of payment for ${i.number}:`);
                  if (ref) run(() => post(`/billing/invoices/${i.id}/paid`, { reference: ref }), `${i.number} marked paid.`);
                }}>Mark paid</button>}
                {(i.status === 'draft' || i.status === 'issued' || i.status === 'overdue') && <button className="btn light sm" onClick={() => {
                  const reason = window.prompt(`Why are you voiding ${i.number}?`);
                  if (reason) run(() => post(`/billing/invoices/${i.id}/void`, { reason }), `${i.number} voided.`);
                }}>Void</button>}
              </div></td>
            </tr>
          ))}
          {!items.length && <tr><td colSpan={8} className="muted">No invoices yet.</td></tr>}
        </tbody>
      </table></div>
    </div>
  );
}
