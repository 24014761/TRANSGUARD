'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import { Invoice, BillingSettings, rand, monthLabel, StatusBadge } from '@/components/Billing';

function InvoiceView() {
  const id = useSearchParams().get('id') || '';
  const [data, setData] = useState<{ invoice: Invoice; settings: BillingSettings } | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      const { data: s } = await supabase.auth.getSession();
      if (!s.session) return setErr('Please sign in first.');
      api<{ invoice: Invoice; settings: BillingSettings }>(`/billing/invoices/${id}`).then(setData).catch((e) => setErr(e.message));
    })();
  }, [id]);

  if (err) return <div className="error" style={{ margin: '2rem' }}>{err}</div>;
  if (!data) return <p className="muted" style={{ margin: '2rem' }}>Loading invoice...</p>;
  const { invoice: i, settings: s } = data;
  const vatPct = Math.round(Number(s.vat_rate) * 10000) / 100;

  return (
    <main className="invoice-page">
      <div className="no-print row" style={{ justifyContent: 'flex-end', marginBottom: '1rem' }}>
        <button className="btn" onClick={() => window.print()}>Print or save as PDF</button>
      </div>
      <div className="invoice-sheet">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div className="logo" style={{ color: 'var(--brand)' }}><span className="logo-mark">T</span> {s.supplier_name}</div>
            <p className="muted" style={{ whiteSpace: 'pre-line', marginTop: '.5rem' }}>{s.supplier_details}</p>
          </div>
          <div style={{ textAlign: 'right' }}>
            <h1 style={{ fontSize: '1.8rem' }}>{i.status === 'draft' ? 'DRAFT INVOICE' : 'TAX INVOICE'}</h1>
            <div><strong>{i.number}</strong></div>
            <div className="muted">Period: {monthLabel(i.period_start)} ({i.period_start} to {i.period_end})</div>
            {i.issued_at && <div className="muted">Issued: {i.issued_at.slice(0, 10)}</div>}
            {i.due_at && <div className="muted">Due: {i.due_at}</div>}
            <div style={{ marginTop: '.4rem' }}><StatusBadge s={i.status} /></div>
          </div>
        </div>

        <div className="card" style={{ margin: '1.5rem 0' }}>
          <div className="muted" style={{ fontSize: '.8rem', textTransform: 'uppercase', letterSpacing: '.4px' }}>Bill to</div>
          <strong>{s.customer_name}</strong>
          <div className="muted" style={{ whiteSpace: 'pre-line' }}>{s.customer_details}</div>
        </div>

        <table>
          <thead><tr><th>Description</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Unit price</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
          <tbody>
            {i.lines.map((l, n) => (
              <tr key={n}><td>{l.description}</td><td style={{ textAlign: 'right' }}>{l.quantity}</td><td style={{ textAlign: 'right' }}>{rand(l.unit_price)}</td><td style={{ textAlign: 'right' }}>{rand(l.amount)}</td></tr>
            ))}
            <tr><td colSpan={3} style={{ textAlign: 'right' }}>Subtotal</td><td style={{ textAlign: 'right' }}>{rand(i.subtotal)}</td></tr>
            {Number(i.sla_credit) > 0 && (
              <tr><td colSpan={3} style={{ textAlign: 'right' }}>SLA credit (uptime {i.sla_uptime_pct}% below {s.sla_target_pct}% target)</td><td style={{ textAlign: 'right' }}>- {rand(i.sla_credit)}</td></tr>
            )}
            <tr><td colSpan={3} style={{ textAlign: 'right' }}>VAT ({vatPct}%)</td><td style={{ textAlign: 'right' }}>{rand(i.vat)}</td></tr>
            <tr><td colSpan={3} style={{ textAlign: 'right' }}><strong>Total due</strong></td><td style={{ textAlign: 'right' }}><strong>{rand(i.total)}</strong></td></tr>
          </tbody>
        </table>

        <p className="muted" style={{ marginTop: '1rem' }}>
          {i.active_transformers} transformer{i.active_transformers === 1 ? '' : 's'} monitored this month (sensor reported at least once).
        </p>

        <div className="card" style={{ marginTop: '1.5rem' }}>
          <h3>How to pay</h3>
          <p style={{ whiteSpace: 'pre-line', margin: '.25rem 0' }}>{s.bank_details}</p>
          <p className="muted" style={{ margin: 0 }}>EFT within {s.payment_terms_days} days. Use <strong>{i.number}</strong> as the payment reference.</p>
          {i.status === 'paid' && <p className="ok" style={{ marginTop: '.75rem' }}>Paid on {i.paid_at?.slice(0, 10)}. Reference: {i.payment_reference}</p>}
        </div>
      </div>
    </main>
  );
}

export default function InvoicePage() {
  return <Suspense fallback={null}><InvoiceView /></Suspense>;
}
