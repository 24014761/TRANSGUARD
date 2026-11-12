import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string;

export const supabase = createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true },
});

export type Role = 'eskom_operator' | 'eskom_crew' | 'councillor' | 'municipal_admin' | 'system_admin';

export type Profile = {
  id: string;
  role: Role;
  display_name: string;
  staff_number: string | null;
  ward_id: string | null;
  status: string;
};

export type Incident = {
  id: string;
  transformer_id: string;
  ward_id: string;
  type: string;
  source: string;
  status: 'NEW' | 'VERIFYING' | 'DISPATCHED' | 'ON_SITE' | 'RESTORED' | 'CLOSED_FALSE';
  confidence: number;
  signal_count: number;
  verified: boolean | null;
  saps_escort: boolean;
  created_at: string;
  asked_at: string | null;
  verify_deadline: string | null;
  dispatched_at: string | null;
  onsite_at: string | null;
  restored_at: string | null;
  transformers?: { name: string | null; lat: number; lng: number; villages?: { name: string } | null } | null;
};

export const ROLE_LABEL: Record<Role, string> = {
  eskom_operator: 'Eskom operator',
  eskom_crew: 'Field crew',
  councillor: 'Ward councillor',
  municipal_admin: 'Municipal admin',
  system_admin: 'System admin',
};
