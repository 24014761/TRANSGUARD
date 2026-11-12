-- TransGuard schema (no household features)
-- Roles: eskom_operator, eskom_crew, councillor, municipal_admin, system_admin

create extension if not exists pgcrypto with schema extensions;

-- ---------- Areas ----------
create table public.wards (
  id            text primary key,              -- e.g. 'THULAMELA-W25'
  municipality  text not null,
  name          text not null
);

create table public.villages (
  id        serial primary key,
  name      text not null,
  ward_id   text not null references public.wards(id)
);

create table public.transformers (
  id            text primary key,              -- Eskom asset number
  name          text,
  village_id    int not null references public.villages(id),
  lat           double precision not null,
  lng           double precision not null,
  capacity_kva  int,
  installed_at  timestamptz
);

-- ---------- Users (linked to Supabase Auth) ----------
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  role          text not null check (role in ('eskom_operator','eskom_crew','councillor','municipal_admin','system_admin')),
  display_name  text not null,
  staff_number  text,
  phone_masked  text,
  ward_id       text references public.wards(id),
  status        text not null default 'active' check (status in ('active','disabled')),
  created_at    timestamptz not null default now()
);

-- ---------- Devices ----------
create table public.devices (
  id              text primary key,
  transformer_id  text not null references public.transformers(id),
  key_hash        text not null,               -- sha256 of the device secret (ATECC608 key in production)
  firmware        text,
  last_seq        bigint not null default 0,   -- anti-replay counter
  last_heartbeat  timestamptz,
  battery_pct     int,
  status          text not null default 'online' check (status in ('online','silent','retired'))
);

create table public.readings (
  device_id    text not null references public.devices(id) on delete cascade,
  ts           timestamptz not null,
  current_a    real, voltage_v real, vibration_g real, temp_c real,
  box_open     boolean, motion boolean, cable_cut boolean,
  primary key (device_id, ts)
);

create table public.integration_keys (
  name      text primary key,                  -- e.g. 'scada'
  key_hash  text not null,
  created_at timestamptz not null default now()
);

-- ---------- Incidents ----------
create table public.incidents (
  id              uuid primary key default gen_random_uuid(),
  transformer_id  text not null references public.transformers(id),
  ward_id         text not null references public.wards(id),
  type            text not null,
  source          text not null check (source in ('sensor','scada','manual')),
  status          text not null default 'NEW' check (status in ('NEW','VERIFYING','DISPATCHED','ON_SITE','RESTORED','CLOSED_FALSE')),
  confidence      int not null,
  signal_count    int not null default 1,
  verified        boolean,
  saps_escort     boolean not null default false,
  crew_id         uuid references public.profiles(id),
  created_at      timestamptz not null default now(),
  asked_at        timestamptz,
  verify_deadline timestamptz,
  dispatched_at   timestamptz,
  onsite_at       timestamptz,
  restored_at     timestamptz,
  closed_at       timestamptz
);
create index incidents_open_idx on public.incidents (transformer_id) where status not in ('RESTORED','CLOSED_FALSE');
create index incidents_ward_idx on public.incidents (ward_id);

create table public.verifications (
  id            uuid primary key default gen_random_uuid(),
  incident_id   uuid not null references public.incidents(id) on delete cascade,
  councillor_id uuid not null references public.profiles(id),
  decision      text not null check (decision in ('confirmed','power_on','unsafe')),
  note          text,
  decided_at    timestamptz not null default now()
);

create table public.evidence (
  id           uuid primary key default gen_random_uuid(),
  incident_id  uuid not null references public.incidents(id) on delete cascade,
  object_key   text not null,
  sha256       text not null,
  captured_at  timestamptz not null
);

-- Notifications to staff and councillors (SMS / push log)
create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  incident_id     uuid references public.incidents(id) on delete cascade,
  ward_id         text references public.wards(id),
  recipient_role  text not null,
  channel         text not null default 'sms',
  body            text not null,
  sent_at         timestamptz not null default now()
);

create table public.loadshedding_slots (
  id          serial primary key,
  village_id  int not null references public.villages(id),
  starts_at   timestamptz not null,
  ends_at     timestamptz not null
);

create table public.audit_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  actor_id   uuid,
  actor_role text,
  action     text not null,
  target     text,
  details    jsonb
);

-- audit_log is append-only
create or replace function public.audit_no_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'audit_log is append-only';
end $$;
create trigger audit_log_immutable before update or delete on public.audit_log
  for each row execute function public.audit_no_change();

-- ---------- Helpers ----------
create or replace function public.my_role() returns text
language sql stable security definer set search_path = '' as $$
  select role from public.profiles where id = auth.uid() and status = 'active'
$$;

create or replace function public.my_ward() returns text
language sql stable security definer set search_path = '' as $$
  select ward_id from public.profiles where id = auth.uid()
$$;

-- Create a profile when an auth user is created by an admin (role set in app_metadata only)
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.raw_app_meta_data ? 'tg_role' then
    insert into public.profiles (id, role, display_name, staff_number, ward_id)
    values (
      new.id,
      new.raw_app_meta_data->>'tg_role',
      coalesce(new.raw_app_meta_data->>'display_name', new.email),
      new.raw_app_meta_data->>'staff_number',
      new.raw_app_meta_data->>'ward_id'
    );
  end if;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Row-level security ----------
alter table public.wards              enable row level security;
alter table public.villages           enable row level security;
alter table public.transformers       enable row level security;
alter table public.profiles           enable row level security;
alter table public.devices            enable row level security;
alter table public.readings           enable row level security;
alter table public.integration_keys   enable row level security;
alter table public.incidents          enable row level security;
alter table public.verifications      enable row level security;
alter table public.evidence           enable row level security;
alter table public.messages           enable row level security;
alter table public.loadshedding_slots enable row level security;
alter table public.audit_log          enable row level security;

-- Reference data: any active staff user can read; admins can write
create policy "staff read wards" on public.wards for select to authenticated using (public.my_role() is not null);
create policy "staff read villages" on public.villages for select to authenticated using (public.my_role() is not null);
create policy "staff read transformers" on public.transformers for select to authenticated using (public.my_role() is not null);
create policy "staff read loadshedding" on public.loadshedding_slots for select to authenticated using (public.my_role() is not null);

create policy "admins write wards" on public.wards for all to authenticated
  using (public.my_role() in ('municipal_admin','system_admin')) with check (public.my_role() in ('municipal_admin','system_admin'));
create policy "admins write villages" on public.villages for all to authenticated
  using (public.my_role() in ('municipal_admin','system_admin')) with check (public.my_role() in ('municipal_admin','system_admin'));
create policy "admins write transformers" on public.transformers for all to authenticated
  using (public.my_role() in ('municipal_admin','system_admin')) with check (public.my_role() in ('municipal_admin','system_admin'));
create policy "operators write loadshedding" on public.loadshedding_slots for all to authenticated
  using (public.my_role() in ('eskom_operator','system_admin')) with check (public.my_role() in ('eskom_operator','system_admin'));

-- Profiles: see yourself; operators and admins see everyone; system admin manages
create policy "read own profile" on public.profiles for select to authenticated using (id = auth.uid());
create policy "staff read profiles" on public.profiles for select to authenticated
  using (public.my_role() in ('eskom_operator','municipal_admin','system_admin'));
create policy "sysadmin manage profiles" on public.profiles for update to authenticated
  using (public.my_role() = 'system_admin') with check (public.my_role() = 'system_admin');

-- Devices and readings: Eskom and admins
create policy "eskom read devices" on public.devices for select to authenticated
  using (public.my_role() in ('eskom_operator','eskom_crew','system_admin','municipal_admin'));
create policy "eskom read readings" on public.readings for select to authenticated
  using (public.my_role() in ('eskom_operator','eskom_crew','system_admin'));

-- Incidents: Eskom and admins see all; councillors only their ward. Writes go through functions.
create policy "eskom read incidents" on public.incidents for select to authenticated
  using (public.my_role() in ('eskom_operator','eskom_crew','system_admin','municipal_admin'));
create policy "councillor read ward incidents" on public.incidents for select to authenticated
  using (public.my_role() = 'councillor' and ward_id = public.my_ward());

create policy "eskom read verifications" on public.verifications for select to authenticated
  using (public.my_role() in ('eskom_operator','system_admin','municipal_admin'));
create policy "councillor read own verifications" on public.verifications for select to authenticated
  using (councillor_id = auth.uid());

create policy "eskom read evidence" on public.evidence for select to authenticated
  using (public.my_role() in ('eskom_operator','eskom_crew','system_admin'));

create policy "eskom read messages" on public.messages for select to authenticated
  using (public.my_role() in ('eskom_operator','system_admin'));
create policy "councillor read ward messages" on public.messages for select to authenticated
  using (public.my_role() = 'councillor' and ward_id = public.my_ward());

create policy "audit readers" on public.audit_log for select to authenticated
  using (public.my_role() in ('eskom_operator','system_admin'));

-- integration_keys: no policies, so only the database owner / service role can read

-- Live dashboards
alter publication supabase_realtime add table public.incidents;
alter publication supabase_realtime add table public.devices;
