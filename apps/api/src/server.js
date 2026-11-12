import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

const {
  PORT = 4000,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY, // optional: only needed for creating staff accounts
  CORS_ORIGINS = '',
  VERIFY_DEADLINE_MINUTES = '10',
} = process.env;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('SUPABASE_URL and SUPABASE_ANON_KEY are required');
  process.exit(1);
}

const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const admin = SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

// A Supabase client that acts as the signed-in user, so row-level security applies
const asUser = (token) =>
  createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json({ limit: '50kb' }));

const allowList = CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (allowList.includes(origin) || /^https:\/\/transguard[a-z0-9-]*\.vercel\.app$/.test(origin) || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
        return cb(null, true);
      }
      return cb(new Error('Origin not allowed'));
    },
  })
);

app.use('/api/', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));
const ingestLimiter = rateLimit({ windowMs: 60_000, limit: 600 });

// ---------- helpers ----------
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  const status = err.status || (err.code === '42501' ? 403 : err.code === '28000' ? 401 : 400);
  res.status(status).json({ error: err.message || 'Request failed' });
});

const fail = (status, message) => Object.assign(new Error(message), { status });

async function requireUser(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) throw fail(401, 'Missing bearer token');
    const { data, error } = await anon.auth.getUser(token);
    if (error || !data.user) throw fail(401, 'Invalid or expired session');
    const db = asUser(token);
    const { data: profile } = await db.from('profiles').select('*').eq('id', data.user.id).maybeSingle();
    if (!profile || profile.status !== 'active') throw fail(403, 'No active TransGuard role for this account');
    req.user = data.user;
    req.profile = profile;
    req.db = db;
    next();
  } catch (err) {
    res.status(err.status || 401).json({ error: err.message });
  }
}

const allow = (...roles) => (req, res, next) =>
  roles.includes(req.profile.role) ? next() : res.status(403).json({ error: 'Not allowed for your role' });

async function rpc(db, fn, args) {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return data;
}

const uuid = z.string().uuid();
const OPEN = ['NEW', 'VERIFYING', 'DISPATCHED', 'ON_SITE'];
const SIGNAL_TYPES = ['CABLE_CUT', 'BOX_OPENED', 'POWER_DROP', 'VIBRATION', 'SENSOR_SILENT', 'OTHER'];

// ---------- routes ----------
const v1 = express.Router();

v1.get('/health', (_req, res) => res.json({ ok: true, service: 'transguard-api', time: new Date().toISOString() }));

v1.get('/me', requireUser, (req, res) => res.json({ id: req.user.id, email: req.user.email, ...req.profile }));

v1.get('/incidents', requireUser, wrap(async (req, res) => {
  const status = String(req.query.status || 'open');
  let q = req.db.from('incidents')
    .select('*, transformers(name, lat, lng, villages(name))')
    .order('created_at', { ascending: false })
    .limit(200);
  if (status === 'open') q = q.in('status', OPEN);
  else if (status !== 'all') q = q.eq('status', status.toUpperCase());
  const { data, error } = await q;
  if (error) throw error;
  res.json(data);
}));

v1.post('/incidents', requireUser, allow('eskom_operator', 'system_admin'), wrap(async (req, res) => {
  const body = z.object({ transformer_id: z.string().min(1).max(40), type: z.enum(SIGNAL_TYPES) }).parse(req.body);
  const id = await rpc(req.db, 'create_manual_incident', { p_transformer: body.transformer_id, p_type: body.type });
  res.status(201).json({ id, filtered: id === null });
}));

v1.post('/incidents/:id/ask-verification', requireUser, allow('eskom_operator', 'system_admin'), wrap(async (req, res) => {
  await rpc(req.db, 'ask_verification', { p_incident: uuid.parse(req.params.id), p_minutes: Number(VERIFY_DEADLINE_MINUTES) });
  res.json({ ok: true });
}));

v1.post('/incidents/:id/dispatch', requireUser, allow('eskom_operator', 'system_admin'), wrap(async (req, res) => {
  await rpc(req.db, 'override_dispatch', { p_incident: uuid.parse(req.params.id) });
  res.json({ ok: true });
}));

v1.post('/incidents/:id/verify', requireUser, allow('councillor'), wrap(async (req, res) => {
  const body = z.object({ decision: z.enum(['confirmed', 'power_on', 'unsafe']), note: z.string().max(500).optional() }).parse(req.body);
  await rpc(req.db, 'verify_incident', { p_incident: uuid.parse(req.params.id), p_decision: body.decision, p_note: body.note ?? null });
  res.json({ ok: true });
}));

v1.post('/incidents/:id/arrived', requireUser, allow('eskom_crew', 'eskom_operator', 'system_admin'), wrap(async (req, res) => {
  await rpc(req.db, 'mark_arrived', { p_incident: uuid.parse(req.params.id) });
  res.json({ ok: true });
}));

v1.post('/incidents/:id/restored', requireUser, allow('eskom_crew', 'eskom_operator', 'system_admin'), wrap(async (req, res) => {
  await rpc(req.db, 'mark_restored', { p_incident: uuid.parse(req.params.id) });
  res.json({ ok: true });
}));

v1.get('/transformers/:id/readings', requireUser, allow('eskom_operator', 'eskom_crew', 'system_admin'), wrap(async (req, res) => {
  const { data: devices, error: e1 } = await req.db.from('devices').select('id').eq('transformer_id', req.params.id);
  if (e1) throw e1;
  const ids = devices.map((d) => d.id);
  if (!ids.length) return res.json([]);
  const { data, error } = await req.db.from('readings').select('*').in('device_id', ids).order('ts', { ascending: false }).limit(100);
  if (error) throw error;
  res.json(data);
}));

v1.get('/reports/kpis', requireUser, allow('eskom_operator', 'system_admin', 'municipal_admin'), wrap(async (req, res) => {
  res.json(await rpc(req.db, 'get_kpis', {}));
}));

v1.get('/reports/incidents.csv', requireUser, allow('eskom_operator', 'system_admin', 'municipal_admin'), wrap(async (req, res) => {
  const { data, error } = await req.db.from('incidents').select('*').order('created_at', { ascending: false }).limit(5000);
  if (error) throw error;
  const cols = ['id', 'transformer_id', 'ward_id', 'type', 'source', 'status', 'confidence', 'signal_count', 'verified',
    'saps_escort', 'created_at', 'asked_at', 'dispatched_at', 'onsite_at', 'restored_at', 'closed_at'];
  const esc = (v) => (v === null || v === undefined ? '' : `"${String(v).replace(/"/g, '""')}"`);
  const csv = [cols.join(','), ...data.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="transguard-incidents.csv"');
  res.send(csv);
}));

// Sensor main units: x-device-key header + monotonic sequence number (anti-replay)
v1.post('/ingest/device', ingestLimiter, wrap(async (req, res) => {
  const key = String(req.headers['x-device-key'] || '');
  if (!key) throw fail(401, 'Missing x-device-key');
  const b = z.object({
    device_id: z.string().max(40), seq: z.number().int().positive(),
    current_a: z.number().optional(), voltage_v: z.number().optional(), vibration_g: z.number().optional(),
    temp_c: z.number().optional(), box_open: z.boolean().optional(), motion: z.boolean().optional(),
    cable_cut: z.boolean().optional(), battery_pct: z.number().int().min(0).max(100).optional(),
  }).parse(req.body);
  const data = await rpc(anon, 'ingest_device_message', {
    p_device: b.device_id, p_key: key, p_seq: b.seq,
    p_current_a: b.current_a ?? null, p_voltage_v: b.voltage_v ?? null, p_vibration_g: b.vibration_g ?? null,
    p_temp_c: b.temp_c ?? null, p_box_open: b.box_open ?? false, p_motion: b.motion ?? false,
    p_cable_cut: b.cable_cut ?? false, p_battery_pct: b.battery_pct ?? null,
  });
  res.json(data);
}));

// Existing Eskom SCADA / sensors: x-api-key header
v1.post('/ingest/scada', ingestLimiter, wrap(async (req, res) => {
  const key = String(req.headers['x-api-key'] || '');
  if (!key) throw fail(401, 'Missing x-api-key');
  const b = z.object({ transformer_id: z.string().max(40), type: z.enum(SIGNAL_TYPES) }).parse(req.body);
  const id = await rpc(anon, 'ingest_scada_alert', { p_key: key, p_transformer: b.transformer_id, p_type: b.type });
  res.json({ incident_id: id, filtered: id === null });
}));

// ---------- Billing: monthly invoices to Eskom ----------
v1.get('/billing/invoices', requireUser, allow('system_admin', 'eskom_operator'), wrap(async (req, res) => {
  const { data, error } = await req.db.from('invoices').select('*').order('period_start', { ascending: false }).limit(120);
  if (error) throw error;
  res.json(data);
}));

v1.get('/billing/invoices/:id', requireUser, allow('system_admin', 'eskom_operator'), wrap(async (req, res) => {
  const [{ data: invoice, error }, { data: settings }] = await Promise.all([
    req.db.from('invoices').select('*').eq('id', uuid.parse(req.params.id)).maybeSingle(),
    req.db.from('billing_settings').select('*').eq('id', 1).maybeSingle(),
  ]);
  if (error) throw error;
  if (!invoice) throw fail(404, 'Invoice not found');
  res.json({ invoice, settings });
}));

v1.post('/billing/invoices', requireUser, allow('system_admin'), wrap(async (req, res) => {
  const b = z.object({
    month: z.string().regex(/^\d{4}-\d{2}$/, 'month must be YYYY-MM'),
    uptime_pct: z.number().min(0).max(100).default(100),
  }).parse(req.body);
  const id = await rpc(req.db, 'generate_invoice', { p_month: `${b.month}-01`, p_uptime: b.uptime_pct });
  res.status(201).json({ id });
}));

// Manual invoice: your own line items (stolen items, repairs, call-outs), optionally linked to an incident
v1.post('/billing/manual-invoices', requireUser, allow('system_admin'), wrap(async (req, res) => {
  const line = z.object({
    description: z.string().trim().min(1).max(200),
    category: z.enum(['subscription', 'hardware', 'service', 'stolen_item', 'repair', 'other']),
    unit: z.string().max(30).default('each'),
    quantity: z.number().positive().max(1_000_000),
    unit_price: z.number().min(0).max(100_000_000),
    vat_applies: z.boolean().default(true),
  });
  const b = z.object({
    title: z.string().trim().min(2).max(150),
    incident_id: z.string().uuid().nullable().optional(),
    customer_name: z.string().max(150).optional(),
    discount: z.number().min(0).default(0),
    notes: z.string().max(1000).optional(),
    lines: z.array(line).min(1).max(50),
  }).parse(req.body);
  const id = await rpc(req.db, 'create_manual_invoice', {
    p_title: b.title, p_lines: b.lines, p_incident: b.incident_id ?? null,
    p_discount: b.discount, p_notes: b.notes ?? null, p_customer: b.customer_name ?? null,
  });
  res.status(201).json({ id });
}));

v1.post('/billing/invoices/:id/issue', requireUser, allow('system_admin'), wrap(async (req, res) => {
  await rpc(req.db, 'issue_invoice', { p_invoice: uuid.parse(req.params.id) });
  res.json({ ok: true });
}));

v1.post('/billing/invoices/:id/paid', requireUser, allow('system_admin'), wrap(async (req, res) => {
  const b = z.object({ reference: z.string().min(2).max(100) }).parse(req.body);
  await rpc(req.db, 'mark_invoice_paid', { p_invoice: uuid.parse(req.params.id), p_reference: b.reference });
  res.json({ ok: true });
}));

v1.post('/billing/invoices/:id/void', requireUser, allow('system_admin'), wrap(async (req, res) => {
  const b = z.object({ reason: z.string().min(2).max(300) }).parse(req.body);
  await rpc(req.db, 'void_invoice', { p_invoice: uuid.parse(req.params.id), p_reason: b.reason });
  res.json({ ok: true });
}));

// System admin: create staff accounts (needs SUPABASE_SERVICE_ROLE_KEY on the server)
v1.post('/admin/users', requireUser, allow('system_admin'), wrap(async (req, res) => {
  if (!admin) throw fail(501, 'Set SUPABASE_SERVICE_ROLE_KEY on the API to create accounts');
  const b = z.object({
    email: z.string().email(), password: z.string().min(12),
    role: z.enum(['eskom_operator', 'eskom_crew', 'councillor', 'municipal_admin', 'system_admin']),
    display_name: z.string().min(2).max(80), staff_number: z.string().max(30).optional(), ward_id: z.string().max(40).optional(),
  }).parse(req.body);
  if (b.role === 'councillor' && !b.ward_id) throw fail(400, 'Councillors need a ward_id');
  const { data, error } = await admin.auth.admin.createUser({
    email: b.email, password: b.password, email_confirm: true,
    app_metadata: { tg_role: b.role, display_name: b.display_name, staff_number: b.staff_number, ward_id: b.ward_id },
  });
  if (error) throw error;
  res.status(201).json({ id: data.user.id });
}));

app.use('/api/v1', v1);
app.get('/', (_req, res) => res.json({ service: 'TransGuard API', docs: '/api/v1/health' }));
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => console.log(`TransGuard API listening on ${PORT}`));
