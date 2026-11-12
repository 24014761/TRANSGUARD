-- TransGuard incident workflow (state machine, confidence, merge, load-shedding filter, escalation)
--
-- NEW --ask--> VERIFYING --confirmed--> DISPATCHED (verified)
--                         --power_on---> CLOSED_FALSE
--                         --unsafe-----> DISPATCHED (SAPS escort)
--                         --deadline---> DISPATCHED (unverified)
-- DISPATCHED --arrived--> ON_SITE --restored--> RESTORED

create or replace function public._audit(p_action text, p_target text, p_details jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.audit_log (actor_id, actor_role, action, target, details)
  values (auth.uid(), coalesce(public.my_role(), 'system'), p_action, p_target, p_details);
$$;

create or replace function public._signal_points(p_type text) returns int
language sql immutable set search_path = '' as $$
  select case upper(p_type)
    when 'CABLE_CUT'     then 55
    when 'BOX_OPENED'    then 45
    when 'POWER_DROP'    then 40
    when 'VIBRATION'     then 30
    when 'SENSOR_SILENT' then 60
    else 40 end
$$;

create or replace function public._require_role(p_roles text[]) returns text
language plpgsql stable security definer set search_path = '' as $$
declare r text := public.my_role();
begin
  if r is null or not (r = any(p_roles)) then
    raise exception 'not allowed for this role' using errcode = '42501';
  end if;
  return r;
end $$;

-- Raise a signal for a transformer: filter load-shedding, merge into an open incident, or create one.
create or replace function public._raise_signal(p_transformer text, p_type text, p_source text, p_bonus int default 0)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_village int; v_ward text; v_inc uuid; v_points int := public._signal_points(p_type);
begin
  select t.village_id, v.ward_id into v_village, v_ward
  from public.transformers t join public.villages v on v.id = t.village_id
  where t.id = p_transformer;
  if v_ward is null then raise exception 'unknown transformer %', p_transformer; end if;

  -- Load-shedding filter: expected power drops are logged, not raised
  if upper(p_type) = 'POWER_DROP' and exists (
    select 1 from public.loadshedding_slots s
    where s.village_id = v_village and now() between s.starts_at and s.ends_at) then
    perform public._audit('signal_filtered_loadshedding', p_transformer, jsonb_build_object('type', p_type, 'source', p_source));
    return null;
  end if;

  select id into v_inc from public.incidents
  where transformer_id = p_transformer and status not in ('RESTORED','CLOSED_FALSE')
  order by created_at desc limit 1 for update;

  if v_inc is not null then
    update public.incidents
       set confidence = least(100, confidence + greatest(8, least(15, v_points / 4)) + p_bonus),
           signal_count = signal_count + 1
     where id = v_inc;
    perform public._audit('incident_merged', v_inc::text, jsonb_build_object('type', p_type, 'source', p_source));
    return v_inc;
  end if;

  insert into public.incidents (transformer_id, ward_id, type, source, confidence)
  values (p_transformer, v_ward, upper(p_type), p_source, least(100, v_points + p_bonus))
  returning id into v_inc;
  perform public._audit('incident_created', v_inc::text, jsonb_build_object('type', p_type, 'source', p_source, 'transformer', p_transformer));
  return v_inc;
end $$;

-- ---------- Operator actions ----------
create or replace function public.create_manual_incident(p_transformer text, p_type text)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  perform public._require_role(array['eskom_operator','system_admin']);
  return public._raise_signal(p_transformer, p_type, 'manual');
end $$;

create or replace function public.ask_verification(p_incident uuid, p_minutes int default 10)
returns void language plpgsql security definer set search_path = '' as $$
declare v public.incidents;
begin
  perform public._require_role(array['eskom_operator','system_admin']);
  select * into v from public.incidents where id = p_incident for update;
  if v.id is null then raise exception 'incident not found'; end if;
  if v.status <> 'NEW' then raise exception 'incident is %, expected NEW', v.status; end if;
  update public.incidents
     set status = 'VERIFYING', asked_at = now(),
         verify_deadline = now() + make_interval(mins => greatest(1, least(60, p_minutes)))
   where id = p_incident;
  insert into public.messages (incident_id, ward_id, recipient_role, channel, body)
  values (p_incident, v.ward_id, 'councillor', 'sms',
          format('TransGuard: Eskom asks you to confirm an electricity fault at transformer %s. Please answer within %s minutes.', v.transformer_id, p_minutes));
  perform public._audit('verification_requested', p_incident::text, jsonb_build_object('minutes', p_minutes));
end $$;

create or replace function public.override_dispatch(p_incident uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v public.incidents;
begin
  perform public._require_role(array['eskom_operator','system_admin']);
  select * into v from public.incidents where id = p_incident for update;
  if v.status not in ('NEW','VERIFYING') then raise exception 'incident is %, cannot dispatch', v.status; end if;
  update public.incidents set status = 'DISPATCHED', dispatched_at = now(), verified = coalesce(verified, false)
   where id = p_incident;
  perform public._audit('dispatch_override', p_incident::text, '{}'::jsonb);
end $$;

-- ---------- Councillor verification ----------
create or replace function public.verify_incident(p_incident uuid, p_decision text, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v public.incidents;
begin
  perform public._require_role(array['councillor']);
  select * into v from public.incidents where id = p_incident for update;
  if v.id is null or v.ward_id is distinct from public.my_ward() then raise exception 'incident not in your ward'; end if;
  if v.status <> 'VERIFYING' then raise exception 'incident is %, not waiting for you', v.status; end if;
  if p_decision not in ('confirmed','power_on','unsafe') then raise exception 'bad decision'; end if;

  insert into public.verifications (incident_id, councillor_id, decision, note)
  values (p_incident, auth.uid(), p_decision, left(p_note, 500));

  if p_decision = 'confirmed' then
    update public.incidents set status = 'DISPATCHED', verified = true, dispatched_at = now(),
           confidence = least(100, confidence + 40) where id = p_incident;
  elsif p_decision = 'unsafe' then
    update public.incidents set status = 'DISPATCHED', verified = true, saps_escort = true, dispatched_at = now(),
           confidence = least(100, confidence + 40) where id = p_incident;
    insert into public.messages (incident_id, ward_id, recipient_role, channel, body)
    values (p_incident, v.ward_id, 'saps', 'sms', format('TransGuard: escort requested for Eskom crew at transformer %s.', v.transformer_id));
  else
    update public.incidents set status = 'CLOSED_FALSE', verified = false, closed_at = now() where id = p_incident;
  end if;
  perform public._audit('councillor_decision', p_incident::text, jsonb_build_object('decision', p_decision));
end $$;

-- ---------- Crew actions ----------
create or replace function public.mark_arrived(p_incident uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v public.incidents;
begin
  perform public._require_role(array['eskom_crew','eskom_operator','system_admin']);
  select * into v from public.incidents where id = p_incident for update;
  if v.status <> 'DISPATCHED' then raise exception 'incident is %, expected DISPATCHED', v.status; end if;
  update public.incidents set status = 'ON_SITE', onsite_at = now(),
         crew_id = case when public.my_role() = 'eskom_crew' then auth.uid() else crew_id end
   where id = p_incident;
  perform public._audit('crew_arrived', p_incident::text, '{}'::jsonb);
end $$;

create or replace function public.mark_restored(p_incident uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v public.incidents;
begin
  perform public._require_role(array['eskom_crew','eskom_operator','system_admin']);
  select * into v from public.incidents where id = p_incident for update;
  if v.status not in ('DISPATCHED','ON_SITE') then raise exception 'incident is %, cannot restore', v.status; end if;
  update public.incidents set status = 'RESTORED', restored_at = now(), closed_at = now(),
         onsite_at = coalesce(onsite_at, now()) where id = p_incident;
  insert into public.messages (incident_id, ward_id, recipient_role, channel, body)
  values (p_incident, v.ward_id, 'councillor', 'sms', format('TransGuard: power restored at transformer %s.', v.transformer_id));
  perform public._audit('power_restored', p_incident::text, '{}'::jsonb);
end $$;

-- ---------- Device and SCADA ingest (called by the API with the device or integration key) ----------
create or replace function public.ingest_device_message(
  p_device text, p_key text, p_seq bigint,
  p_current_a real default null, p_voltage_v real default null, p_vibration_g real default null,
  p_temp_c real default null, p_box_open boolean default false, p_motion boolean default false,
  p_cable_cut boolean default false, p_battery_pct int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare d public.devices; v_inc uuid; v_signals text[] := '{}'; s text; v_bonus int := 0;
begin
  select * into d from public.devices where id = p_device for update;
  if d.id is null or d.key_hash <> encode(extensions.digest(p_key, 'sha256'), 'hex') then
    raise exception 'device authentication failed' using errcode = '28000';
  end if;
  if p_seq <= d.last_seq then
    perform public._audit('replay_blocked', p_device, jsonb_build_object('seq', p_seq, 'last_seq', d.last_seq));
    raise exception 'replayed or old sequence number' using errcode = '28000';
  end if;

  insert into public.readings (device_id, ts, current_a, voltage_v, vibration_g, temp_c, box_open, motion, cable_cut)
  values (p_device, now(), p_current_a, p_voltage_v, p_vibration_g, p_temp_c, p_box_open, p_motion, p_cable_cut)
  on conflict do nothing;
  update public.devices set last_seq = p_seq, last_heartbeat = now(),
         battery_pct = coalesce(p_battery_pct, battery_pct), status = 'online' where id = p_device;

  if p_cable_cut then v_signals := array_append(v_signals, 'CABLE_CUT'); end if;
  if p_box_open then v_signals := array_append(v_signals, 'BOX_OPENED'); end if;
  if coalesce(p_current_a, 1) = 0 or coalesce(p_voltage_v, 230) < 50 then
    v_signals := array_append(v_signals, 'POWER_DROP');
    if coalesce(p_vibration_g, 0) > 1.5 then v_bonus := 10; end if;
  elsif coalesce(p_vibration_g, 0) > 1.5 then
    v_signals := array_append(v_signals, 'VIBRATION');
  end if;

  foreach s in array v_signals loop
    v_inc := coalesce(public._raise_signal(d.transformer_id, s, 'sensor', case when s = 'POWER_DROP' then v_bonus else 0 end), v_inc);
  end loop;
  return jsonb_build_object('ok', true, 'signals', to_jsonb(v_signals), 'incident_id', v_inc);
end $$;

create or replace function public.ingest_scada_alert(p_key text, p_transformer text, p_type text)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.integration_keys
                 where name = 'scada' and key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex')) then
    raise exception 'integration authentication failed' using errcode = '28000';
  end if;
  return public._raise_signal(p_transformer, p_type, 'scada');
end $$;

-- ---------- Timers: verification deadline and sensor heartbeat ----------
create or replace function public.run_escalations(p_heartbeat_minutes int default 3)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r record; n_esc int := 0; n_silent int := 0;
begin
  for r in select id from public.incidents where status = 'VERIFYING' and verify_deadline < now() for update loop
    update public.incidents set status = 'DISPATCHED', verified = false, dispatched_at = now() where id = r.id;
    perform public._audit('auto_escalated_unverified', r.id::text, '{}'::jsonb);
    n_esc := n_esc + 1;
  end loop;
  for r in select id, transformer_id from public.devices
           where status = 'online' and last_heartbeat < now() - make_interval(mins => p_heartbeat_minutes) for update loop
    update public.devices set status = 'silent' where id = r.id;
    perform public._raise_signal(r.transformer_id, 'SENSOR_SILENT', 'sensor');
    n_silent := n_silent + 1;
  end loop;
  return jsonb_build_object('escalated', n_esc, 'silent_devices', n_silent);
end $$;

-- ---------- KPIs ----------
create or replace function public.get_kpis()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._require_role(array['eskom_operator','system_admin','municipal_admin']);
  return jsonb_build_object(
    'open_incidents',        (select count(*) from public.incidents where status not in ('RESTORED','CLOSED_FALSE')),
    'verifying',             (select count(*) from public.incidents where status = 'VERIFYING'),
    'confirmed_outages',     (select count(*) from public.incidents where verified is true),
    'false_trips_avoided',   (select count(*) from public.incidents where status = 'CLOSED_FALSE'),
    'restored',              (select count(*) from public.incidents where status = 'RESTORED'),
    'avg_minutes_to_dispatch', (select round(avg(extract(epoch from dispatched_at - created_at)) / 60.0, 1)
                                from public.incidents where dispatched_at is not null),
    'avg_minutes_to_restore',  (select round(avg(extract(epoch from restored_at - created_at)) / 60.0, 1)
                                from public.incidents where restored_at is not null),
    'transformers',          (select count(*) from public.transformers),
    'devices_online',        (select count(*) from public.devices where status = 'online'),
    'devices_silent',        (select count(*) from public.devices where status = 'silent')
  );
end $$;

-- ---------- Grants: only the intended entry points are callable ----------
revoke execute on function public._audit(text, text, jsonb) from public, anon, authenticated;
revoke execute on function public._raise_signal(text, text, text, int) from public, anon, authenticated;
revoke execute on function public._require_role(text[]) from public, anon, authenticated;
revoke execute on function public.run_escalations(int) from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.audit_no_change() from public, anon, authenticated;

revoke execute on function public.create_manual_incident(text, text) from public, anon;
revoke execute on function public.ask_verification(uuid, int) from public, anon;
revoke execute on function public.override_dispatch(uuid) from public, anon;
revoke execute on function public.verify_incident(uuid, text, text) from public, anon;
revoke execute on function public.mark_arrived(uuid) from public, anon;
revoke execute on function public.mark_restored(uuid) from public, anon;
revoke execute on function public.get_kpis() from public, anon;
grant execute on function public.create_manual_incident(text, text) to authenticated;
grant execute on function public.ask_verification(uuid, int) to authenticated;
grant execute on function public.override_dispatch(uuid) to authenticated;
grant execute on function public.verify_incident(uuid, text, text) to authenticated;
grant execute on function public.mark_arrived(uuid) to authenticated;
grant execute on function public.mark_restored(uuid) to authenticated;
grant execute on function public.get_kpis() to authenticated;

-- Ingest is key-authenticated inside the function, so the API can call it without a user session
grant execute on function public.ingest_device_message(text, text, bigint, real, real, real, real, boolean, boolean, boolean, int) to anon, authenticated;
grant execute on function public.ingest_scada_alert(text, text, text) to anon, authenticated;

-- Escalation timer: every minute
create extension if not exists pg_cron;
select cron.schedule('transguard-escalations', '* * * * *', $$select public.run_escalations(3)$$);
