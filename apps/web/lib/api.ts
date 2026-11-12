import { supabase } from './supabase';

const API = (process.env.NEXT_PUBLIC_API_URL || '').replace(/\/$/, '');

async function token() {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token;
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const t = await token();
  const res = await fetch(`${API}/api/v1${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(t ? { Authorization: `Bearer ${t}` } : {}),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      msg = (await res.json()).error || msg;
    } catch {}
    throw new Error(msg);
  }
  const type = res.headers.get('content-type') || '';
  return (type.includes('application/json') ? res.json() : res.text()) as Promise<T>;
}

export const post = <T = unknown>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });

export async function downloadCsv() {
  const csv = await api<string>('/reports/incidents.csv');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'transguard-incidents.csv';
  a.click();
  URL.revokeObjectURL(url);
}

export function level(c: number) {
  if (c >= 85) return 'CRITICAL';
  if (c >= 60) return 'HIGH';
  if (c >= 35) return 'MEDIUM';
  return 'LOW';
}

export function ago(iso: string | null) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString('en-ZA');
}
