# TransGuard

Hybrid IoT and human response platform for reporting electricity faults. Transformer sensors (or existing Eskom SCADA alarms) raise alerts, Eskom asks the ward councillor to confirm, and crews are dispatched only to verified faults.

Pilot area: Vhembe District, Limpopo. Origin: UNIVEN x CSIR 2026 CyberSecureTech Innovation Hackathon.

> This version has **no household features**: no household registration, household login, household reports or household SMS. Alerts come from sensors, SCADA and Eskom operators; councillors verify.

## Live services

- API (Render): https://transguard-api-kf4l.onrender.com/api/v1/health
- Web (Vercel): project `transguard`, deploys from `main`, root `apps/web`
- Database (Supabase): project `transguard`, region eu-central-1

## Stack

| Part | Where | Folder |
|---|---|---|
| Database, login, realtime | Supabase (PostgreSQL, Auth, Realtime, pg_cron) | `db/` |
| Front end | Next.js 14 on Vercel | `apps/web` |
| Back end API | Node.js (Express) on Render | `apps/api` |
| Code and CI | GitHub + GitHub Actions + Dependabot | `.github/` |

## Roles

| Role | Can do |
|---|---|
| Eskom operator | Live alerts and map, ask councillor, dispatch override, sensors, load-shedding slots, audit log, CSV export |
| Field crew | See dispatched jobs, navigate by GPS, mark arrived and restored |
| Ward councillor | Confirm outages in own ward only (Yes / No, power on / Unsafe), see decisions and messages |
| Municipal admin | Manage wards, villages, transformers |
| System admin | Everything above plus staff accounts |

## Incident workflow

```
NEW --ask--> VERIFYING --confirmed--> DISPATCHED (verified)
                       --power_on---> CLOSED_FALSE
                       --unsafe-----> DISPATCHED (SAPS escort)
                       --deadline---> DISPATCHED (unverified)
DISPATCHED --arrived--> ON_SITE --restored--> RESTORED
```

The state machine lives in Postgres functions (`db/migrations/002_workflow.sql`), so every path (web, API, cron) follows the same rules:

- Confidence: cable cut 55, box opened 45, power drop 40, vibration 30, sensor silent 60, 0 A with strong vibration +10, each merged signal +8 to +15, councillor confirms +40. Levels: LOW < 35, MEDIUM 35-59, HIGH 60-84, CRITICAL 85+.
- New signals for a transformer with an open incident are **merged**.
- Power drops during a **load-shedding slot** are filtered and logged.
- `pg_cron` runs every minute: unanswered verifications are sent as **unverified**, and devices silent for 3 minutes raise **SENSOR_SILENT**.
- Every action is written to `audit_log`, which is append-only (a trigger blocks update and delete).

## Billing (Eskom pays monthly)

- Plans: **pilot** (flat monthly fee up to a transformer limit, extra transformers at the municipal price), **municipal** and **provincial** (price per active transformer). Prices, VAT, payment terms, SLA and bank details are edited by the system admin under Administration > Billing.
- An **active transformer** is one whose sensor sent at least one reading in the month.
- Flow: create draft > issue (sets the due date) > mark paid with the EFT reference, or void. A daily job marks unpaid invoices overdue. Eskom operators see issued invoices under Invoices and can print them (`/invoice?id=...`).
- If platform uptime for the month is below the SLA target, a service credit is deducted before VAT.
- **Write an invoice** (Billing > Write an invoice): free line items with quantity, unit, price and a VAT switch per line; link it to an incident to get suggested lines for that kind of event (cable cut, box opened, sensor silent, vibration, power drop); add a SAPS case number and Eskom purchase order. Totals, VAT (taxable lines only, after any discount) and the value of stolen items are calculated live and recalculated by the database (`create_manual_invoice`).
- **Price list** (Billing > Price list): editable catalogue of suggested items. Prices marked "Estimate" are starting points only.

## Security

- Supabase Auth (email + password) for staff. Roles live in `profiles` and are set from `app_metadata`, which users cannot edit.
- Row-level security on every table. Councillors only see their own ward.
- Writes go through `SECURITY DEFINER` functions that check the caller's role.
- Devices authenticate with a per-device secret (stored only as a SHA-256 hash) and a monotonic sequence number; replays are rejected and logged.
- API: Helmet headers, CORS allow-list, rate limits, Zod validation. Front end: HSTS, nosniff, frame deny.

## API (`/api/v1`)

| Method and path | Who |
|---|---|
| `GET /health` | Anyone |
| `GET /me` | Signed in |
| `GET /incidents?status=open\|all\|NEW...` | Signed in (filtered by role) |
| `POST /incidents` | Operator (manual fault) |
| `POST /incidents/:id/ask-verification` | Operator |
| `POST /incidents/:id/dispatch` | Operator (override) |
| `POST /incidents/:id/verify` | Councillor `{ decision, note }` |
| `POST /incidents/:id/arrived`, `/restored` | Crew, operator |
| `GET /transformers/:id/readings` | Eskom |
| `GET /reports/kpis`, `/reports/incidents.csv` | Operator, admins |
| `POST /ingest/device` | Sensor (`x-device-key`) |
| `POST /ingest/scada` | SCADA (`x-api-key`) |
| `GET /billing/invoices`, `GET /billing/invoices/:id` | System admin, operator |
| `POST /billing/invoices` `{ month: "YYYY-MM", uptime_pct }` | System admin (creates a draft) |
| `POST /billing/manual-invoices` `{ title, incident_id?, customer_name?, discount, notes?, lines[] }` | System admin |
| `POST /billing/invoices/:id/issue`, `/paid` `{ reference }`, `/void` `{ reason }` | System admin |
| `POST /admin/users` | System admin (needs `SUPABASE_SERVICE_ROLE_KEY`) |

Send `Authorization: Bearer <supabase access token>` for signed-in routes.

## Run locally

```bash
# API
cd apps/api && cp .env.example .env   # fill in values
npm install && npm run dev

# Web
cd apps/web && cp .env.example .env.local
npm install && npm run dev
```

Simulate a sensor:

```bash
cd apps/api
API_URL=http://localhost:4000 DEVICE_KEY=<device key> node scripts/simulate.js DEV-1003 cable_cut
```

## Database setup (new Supabase project)

Run in order in the SQL editor: `db/migrations/001_schema.sql`, `002_workflow.sql`, `003_tighten_helpers.sql`, `004_billing.sql`, `005_manual_invoices.sql`, then `db/seed/seed_demo.sql` (replace the placeholder keys first). Create staff users from the admin dashboard or the Supabase dashboard with `app_metadata` like `{"tg_role":"councillor","display_name":"...","ward_id":"THULAMELA-W25"}`.

## Not yet built (from the spec)

SMS gateway (messages are logged in `messages`, ready for BulkSMS/Clickatell/Twilio), SMS PIN two-step login, FIDO2 for admins, evidence photo uploads, translations (Tshivenda, Xitsonga, Sepedi), official load-shedding feed import.

All names, wards, transformers and accounts in the seed data are made up.
