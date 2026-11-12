'use client';
import { useCallback, useEffect, useState } from 'react';
import { supabase, Incident } from '@/lib/supabase';

const OPEN = ['NEW', 'VERIFYING', 'DISPATCHED', 'ON_SITE'];

// Live incidents: reads through row-level security, refreshes on realtime changes
export function useIncidents(scope: 'open' | 'all' = 'open') {
  const [items, setItems] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    let q = supabase
      .from('incidents')
      .select('*, transformers(name, lat, lng, villages(name))')
      .order('created_at', { ascending: false })
      .limit(200);
    if (scope === 'open') q = q.in('status', OPEN);
    const { data } = await q;
    setItems((data as Incident[]) || []);
    setLoading(false);
  }, [scope]);

  useEffect(() => {
    load();
    const ch = supabase
      .channel(`incidents-${scope}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'incidents' }, () => load())
      .subscribe();
    const t = setInterval(load, 30000);
    return () => {
      supabase.removeChannel(ch);
      clearInterval(t);
    };
  }, [load, scope]);

  return { items, loading, reload: load };
}

export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
