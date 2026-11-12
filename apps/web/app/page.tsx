import Link from 'next/link';
import TopBar from '@/components/TopBar';

const steps = [
  ['Detect', 'A clip-on transformer or cable sensor picks up a fault or tampering, or an existing Eskom SCADA alarm fires.'],
  ['Alert Eskom', 'A signed, encrypted alert reaches the Eskom dashboard within seconds, with a confidence score.'],
  ['Ask the councillor', 'Eskom asks the ward councillor to confirm that there is really no electricity.'],
  ['Verify', 'The councillor taps "Yes, no electricity", "No, power is on" or "I can\'t check safely".'],
  ['Dispatch', 'The crew is sent with GPS, sensor data and evidence. Unsafe sites get a SAPS escort request.'],
  ['Restore', 'The crew closes the job and the councillor is told that power is back.'],
];

const roles = [
  ['Eskom operator', 'Sees live alerts, the map and sensor readings, asks the councillor, dispatches crews and exports reports.'],
  ['Field crew', 'Receives jobs on a phone, navigates by GPS, marks arrived and restored.'],
  ['Ward councillor', 'Confirms or rejects outages in their own ward with one tap and keeps a record of decisions.'],
  ['Municipal admin', 'Manages wards, villages and transformers.'],
  ['System admin', 'Manages devices, staff accounts and the audit log.'],
];

const faqs = [
  ['Why does a councillor need to confirm?', 'Sensors are fast but can trip falsely. Councillor confirmation means crews are only sent to real, high-priority faults, which turns alarm fatigue into actionable intelligence.'],
  ['What if the councillor does not answer?', 'After the deadline (10 minutes by default) the job is sent automatically and marked as unverified, so nobody waits.'],
  ['Does load-shedding cause false alarms?', 'No. Power drops during a scheduled load-shedding slot are filtered and logged, but no incident is created.'],
  ['How is the system protected?', 'Each sensor has its own secret key, every message carries a sequence number so replays are rejected, every action is written to an append-only audit log, and each role only sees what it needs.'],
];

export default function Home() {
  return (
    <>
      <TopBar right={<><Link className="btn amber" href="/login?as=eskom">Eskom login</Link><Link className="btn ghost" href="/login?as=councillor">Councillor login</Link></>} />
      <main>
        <section className="hero">
          <div className="container">
            <p className="badge" style={{ background: 'rgba(255,255,255,.15)', color: '#fff' }}>Pilot: Vhembe District, Limpopo</p>
            <h1>Electricity faults reported automatically and verified in minutes.</h1>
            <p>
              TransGuard joins clip-on transformer sensors with human verification by the ward councillor, so Eskom sends crews only to
              confirmed faults, without repeated phone calls or long queues.
            </p>
            <div className="actions">
              <Link className="btn amber" href="/login?as=eskom">Eskom login</Link>
              <Link className="btn ghost" href="/login?as=councillor">Councillor login</Link>
            </div>
          </div>
        </section>

        <section className="block">
          <div className="container">
            <h2>The problem</h2>
            <div className="grid c2">
              <div className="card"><h3>Slow, repeated reporting</h3><p className="muted">Community members make repeated calls or wait in long queues at Eskom offices to report a fault.</p></div>
              <div className="card"><h3>Theft and vandalism</h3><p className="muted">43 transformers were taken in Limpopo in 2022-23 and only R65,000 of R8.1 million was recovered (Parliamentary reply PQ68, February 2024).</p></div>
            </div>
          </div>
        </section>

        <section className="block" style={{ background: '#fff' }}>
          <div className="container">
            <h2>How it works</h2>
            <div className="grid c3">
              {steps.map(([t, d], i) => (
                <div className="card" key={t}><div className="step-num">{i + 1}</div><h3>{t}</h3><p className="muted">{d}</p></div>
              ))}
            </div>
          </div>
        </section>

        <section className="block">
          <div className="container">
            <h2>Who uses TransGuard</h2>
            <div className="grid c3">
              {roles.map(([t, d]) => (<div className="card" key={t}><h3>{t}</h3><p className="muted">{d}</p></div>))}
            </div>
          </div>
        </section>

        <section className="block" style={{ background: '#fff' }}>
          <div className="container">
            <h2>Sensors</h2>
            <p className="muted">Current, voltage, vibration, temperature, box door, motion, cable cut, battery and a heartbeat every 5 minutes. A sensor that goes silent for 3 minutes raises its own alarm, which also covers jamming and smashing. Existing Eskom SCADA alarms can feed in directly.</p>
          </div>
        </section>

        <section className="block">
          <div className="container">
            <h2>Questions</h2>
            {faqs.map(([q, a]) => (<details key={q}><summary>{q}</summary><p className="muted">{a}</p></details>))}
          </div>
        </section>
      </main>
      <footer><div className="container">TransGuard, UNIVEN x CSIR 2026 CyberSecureTech Innovation Hackathon. Demo data only.</div></footer>
    </>
  );
}
