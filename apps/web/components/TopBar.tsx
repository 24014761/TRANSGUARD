'use client';
import Link from 'next/link';

export default function TopBar({ right }: { right?: React.ReactNode }) {
  return (
    <header className="topbar">
      <div className="container">
        <Link href="/" className="logo" aria-label="TransGuard home">
          <span className="logo-mark" aria-hidden>T</span> TransGuard
        </Link>
        <nav>{right}</nav>
      </div>
    </header>
  );
}
