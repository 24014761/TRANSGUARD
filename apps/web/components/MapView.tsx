'use client';
import { useEffect, useRef } from 'react';
import type { Map as LMap, LayerGroup } from 'leaflet';
import { level } from '@/lib/api';

export type MapPoint = { id: string; name: string; lat: number; lng: number; confidence?: number; status?: string };

const COLORS: Record<string, string> = { LOW: '#2563a8', MEDIUM: '#f2a900', HIGH: '#d9730d', CRITICAL: '#c0392b' };

export default function MapView({ points }: { points: MapPoint[] }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<LMap | null>(null);
  const layer = useRef<LayerGroup | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = (await import('leaflet')).default;
      if (cancelled || !el.current) return;
      if (!map.current) {
        map.current = L.map(el.current).setView([-22.945, 30.45], 11);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 18,
          attribution: '&copy; OpenStreetMap contributors',
        }).addTo(map.current);
        layer.current = L.layerGroup().addTo(map.current);
      }
      layer.current!.clearLayers();
      points.forEach((p) => {
        const alert = p.confidence !== undefined;
        const color = alert ? COLORS[level(p.confidence!)] : '#1f8a4c';
        L.circleMarker([p.lat, p.lng], { radius: alert ? 11 : 7, color, fillColor: color, fillOpacity: 0.75, weight: 2 })
          .bindPopup(`<strong>${p.name}</strong><br/>${p.id}${alert ? `<br/>${p.status} . confidence ${p.confidence}` : '<br/>No open alert'}`)
          .addTo(layer.current!);
      });
    })();
    return () => { cancelled = true; };
  }, [points]);

  useEffect(() => () => { map.current?.remove(); map.current = null; }, []);

  return <div ref={el} className="map" role="region" aria-label="Map of transformers and alerts" />;
}
