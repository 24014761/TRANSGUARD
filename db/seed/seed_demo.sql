-- Demo data only. All names, wards and assets are made up. Never seed real people.
-- Replace :DEVICE_KEY and :SCADA_KEY with your own secrets before running.

insert into public.wards (id, municipality, name) values
  ('THULAMELA-W25', 'Thulamela', 'Ward 25 (demo)'),
  ('THULAMELA-W14', 'Thulamela', 'Ward 14 (demo)');

insert into public.villages (name, ward_id) values
  ('Midoroni', 'THULAMELA-W25'),
  ('Tshilidzini', 'THULAMELA-W25'),
  ('Makwarela', 'THULAMELA-W14'),
  ('Shayandima', 'THULAMELA-W14');

insert into public.transformers (id, name, village_id, lat, lng, capacity_kva, installed_at)
select x.id, x.name, v.id, x.lat, x.lng, x.kva, now() - interval '3 years'
from (values
  ('TX-VH-1001', 'Midoroni North',   'Midoroni',    -22.9126, 30.4402, 100),
  ('TX-VH-1002', 'Midoroni School',  'Midoroni',    -22.9171, 30.4458, 50),
  ('TX-VH-1003', 'Tshilidzini Clinic','Tshilidzini',-22.9605, 30.4170, 200),
  ('TX-VH-1004', 'Makwarela Main',   'Makwarela',   -22.9372, 30.4651, 100),
  ('TX-VH-1005', 'Shayandima East',  'Shayandima',  -22.9938, 30.4703, 100)
) as x(id, name, village, lat, lng, kva)
join public.villages v on v.name = x.village;

insert into public.devices (id, transformer_id, key_hash, firmware, last_seq, last_heartbeat, battery_pct, status)
select 'DEV-' || substr(t.id, 7), t.id, encode(extensions.digest(':DEVICE_KEY', 'sha256'), 'hex'), 'tg-esp32 1.0.0', 0, null, 96, 'online'
from public.transformers t;

insert into public.integration_keys (name, key_hash)
values ('scada', encode(extensions.digest(':SCADA_KEY', 'sha256'), 'hex'));
