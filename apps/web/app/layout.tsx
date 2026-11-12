import type { Metadata, Viewport } from 'next';
import 'leaflet/dist/leaflet.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'TransGuard | Faster, verified electricity fault response',
  description:
    'TransGuard connects transformer sensors, Eskom and ward councillors so electricity faults are reported automatically and verified within minutes. Pilot: Vhembe District, Limpopo.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#12324f' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
