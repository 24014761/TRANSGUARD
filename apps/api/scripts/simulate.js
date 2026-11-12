// Sensor simulator: sends heartbeats and optional fault events to the API.
// Usage:
//   API_URL=https://<your-api>.onrender.com DEVICE_KEY=<key> node scripts/simulate.js [DEVICE_ID] [event]
//   event: normal | cable_cut | box_open | power_drop | vibration
const API_URL = process.env.API_URL || 'http://localhost:4000';
const DEVICE_KEY = process.env.DEVICE_KEY;
const deviceId = process.argv[2] || 'DEV-1001';
const event = process.argv[3] || 'normal';

if (!DEVICE_KEY) {
  console.error('Set DEVICE_KEY');
  process.exit(1);
}

const reading = {
  device_id: deviceId,
  seq: Date.now(), // monotonic sequence number
  current_a: 42.5, voltage_v: 231, vibration_g: 0.2, temp_c: 31, battery_pct: 95,
  box_open: false, motion: false, cable_cut: false,
};
if (event === 'cable_cut') Object.assign(reading, { cable_cut: true, current_a: 0, vibration_g: 2.1 });
if (event === 'box_open') Object.assign(reading, { box_open: true, motion: true });
if (event === 'power_drop') Object.assign(reading, { current_a: 0, voltage_v: 0 });
if (event === 'vibration') Object.assign(reading, { vibration_g: 2.4, motion: true });

const res = await fetch(`${API_URL}/api/v1/ingest/device`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-device-key': DEVICE_KEY },
  body: JSON.stringify(reading),
});
console.log(res.status, await res.text());
