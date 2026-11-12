-- Manual invoices: write your own line items (stolen items, repairs, call-outs), link to an incident,
-- totals and VAT calculated by the database. Plus an editable price list of suggested items.

alter table public.invoices
  add column kind        text not null default 'subscription' check (kind in ('subscription','manual')),
  add column title       text,
  add column incident_id uuid references public.incidents(id),
  add column customer_name text,
  add column discount    numeric(12,2) not null default 0,
  add column loss_total  numeric(12,2) not null default 0;

drop index if exists public.invoices_one_per_month;
create unique index invoices_one_per_month on public.invoices (period_start)
  where status <> 'void' and kind = 'subscription';

create table public.invoice_catalog (
  id          serial primary key,
  category    text not null check (category in ('subscription','hardware','service','stolen_item','repair','other')),
  name        text not null,
  unit        text not null default 'each',
  unit_price  numeric(12,2) not null default 0,
  vat_applies boolean not null default true,
  note        text,
  active      boolean not null default true
);
alter table public.invoice_catalog enable row level security;
create policy "catalog readers" on public.invoice_catalog for select to authenticated
  using (public.my_role() in ('system_admin','eskom_operator'));
create policy "sysadmin manages catalog" on public.invoice_catalog for all to authenticated
  using (public.my_role() = 'system_admin') with check (public.my_role() = 'system_admin');

insert into public.invoice_catalog (category, name, unit, unit_price, vat_applies, note) values
  ('subscription','TransGuard pilot subscription (month)','month',18000,true,'From the pitch deck'),
  ('subscription','Monitored transformer (municipal plan)','transformer/month',650,true,'From the pitch deck'),
  ('subscription','Monitored transformer (provincial plan)','transformer/month',450,true,'From the pitch deck'),
  ('hardware','Sensor kit supply and installation','unit',4500,true,'Estimate: confirm with supplier'),
  ('hardware','Replacement sensor kit (stolen or damaged)','unit',3500,true,'Estimate: confirm with supplier'),
  ('service','Emergency site call-out','call-out',850,true,'Estimate'),
  ('service','Technician labour','hour',450,true,'Estimate'),
  ('service','Travel to site','km',5.50,true,'Estimate'),
  ('service','Overnight site security','night',1200,true,'Estimate'),
  ('service','SMS alerts bundle','SMS',0.35,true,'Estimate: confirm with SMS provider'),
  ('stolen_item','Transformer (average loss, Limpopo 2022-23)','transformer',188372,false,'R8.1m across 43 transformers (PQ68, Feb 2024)'),
  ('stolen_item','Copper cable','metre',350,false,'Estimate: confirm with Eskom stores'),
  ('stolen_item','Transformer oil','litre',60,false,'Estimate'),
  ('stolen_item','Aluminium conductor','metre',120,false,'Estimate'),
  ('repair','Enclosure or box door repair','job',2500,true,'Estimate'),
  ('repair','Fence or palisade repair','metre',450,true,'Estimate'),
  ('repair','Cable jointing and reconnection','joint',1800,true,'Estimate'),
  ('other','Report and evidence pack for SAPS or insurer','report',750,true,'Estimate');

-- Create a manual invoice. The database recalculates every amount, so totals cannot be tampered with.
create or replace function public.create_manual_invoice(
  p_title text, p_lines jsonb, p_incident uuid default null, p_discount numeric default 0,
  p_notes text default null, p_customer text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  s public.billing_settings; l jsonb; v_lines jsonb := '[]'::jsonb;
  v_sub numeric := 0; v_vatable numeric := 0; v_loss numeric := 0; v_amt numeric;
  v_qty numeric; v_price numeric; v_vat numeric; v_disc numeric; v_num text; v_id uuid; v_today date := current_date;
begin
  perform public._require_role(array['system_admin']);
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 50 then
    raise exception 'add between 1 and 50 lines';
  end if;
  if p_incident is not null and not exists (select 1 from public.incidents where id = p_incident) then
    raise exception 'incident not found';
  end if;
  select * into s from public.billing_settings where id = 1;

  for l in select * from jsonb_array_elements(p_lines) loop
    v_qty := (l->>'quantity')::numeric;
    v_price := (l->>'unit_price')::numeric;
    if coalesce(trim(l->>'description'), '') = '' then raise exception 'every line needs a description'; end if;
    if v_qty is null or v_qty <= 0 then raise exception 'quantity must be more than 0 (%)', l->>'description'; end if;
    if v_price is null or v_price < 0 then raise exception 'price cannot be negative (%)', l->>'description'; end if;
    v_amt := round(v_qty * v_price, 2);
    v_sub := v_sub + v_amt;
    if coalesce((l->>'vat_applies')::boolean, true) then v_vatable := v_vatable + v_amt; end if;
    if l->>'category' = 'stolen_item' then v_loss := v_loss + v_amt; end if;
    v_lines := v_lines || jsonb_build_object(
      'description', left(l->>'description', 200), 'category', coalesce(l->>'category', 'other'),
      'unit', left(coalesce(l->>'unit', 'each'), 30), 'quantity', v_qty, 'unit_price', v_price,
      'vat_applies', coalesce((l->>'vat_applies')::boolean, true), 'amount', v_amt);
  end loop;

  v_disc := least(greatest(coalesce(p_discount, 0), 0), v_sub);
  -- discount reduces the VAT base in proportion
  v_vat := case when v_sub = 0 then 0 else round((v_vatable - v_disc * v_vatable / v_sub) * s.vat_rate, 2) end;
  v_num := 'TG-M-' || to_char(v_today, 'YYYYMMDD') || '-' ||
           lpad(((select count(*) from public.invoices where kind = 'manual' and created_at::date = v_today) + 1)::text, 2, '0');

  insert into public.invoices (number, kind, title, incident_id, customer_name, period_start, period_end, plan,
    active_transformers, lines, subtotal, discount, vat, total, loss_total, notes)
  values (v_num, 'manual', left(p_title, 150), p_incident, nullif(left(p_customer, 150), ''), v_today, v_today, 'manual',
    0, v_lines, v_sub, v_disc, v_vat, v_sub - v_disc + v_vat, v_loss, left(p_notes, 1000))
  returning id into v_id;
  perform public._audit('manual_invoice_created', v_id::text, jsonb_build_object('number', v_num, 'total', v_sub - v_disc + v_vat, 'incident', p_incident));
  return v_id;
end $$;

revoke execute on function public.create_manual_invoice(text, jsonb, uuid, numeric, text, text) from public, anon;
grant execute on function public.create_manual_invoice(text, jsonb, uuid, numeric, text, text) to authenticated;

-- Monthly subscription invoices only clash with other subscription invoices
create or replace function public.generate_invoice(p_month date, p_uptime numeric default 100)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  s public.billing_settings; v_start date := date_trunc('month', p_month)::date;
  v_end date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  v_active int; v_lines jsonb := '[]'::jsonb; v_sub numeric := 0; v_credit numeric := 0;
  v_vat numeric; v_id uuid; v_extra int; v_num text;
begin
  perform public._require_role(array['system_admin']);
  if v_start > date_trunc('month', now())::date then raise exception 'cannot invoice a future month'; end if;
  if exists (select 1 from public.invoices where period_start = v_start and status <> 'void' and kind = 'subscription') then
    raise exception 'an invoice for % already exists (void it first to regenerate)', to_char(v_start, 'Mon YYYY');
  end if;
  select * into s from public.billing_settings where id = 1;

  select count(distinct d.transformer_id) into v_active
  from public.devices d
  where exists (select 1 from public.readings r where r.device_id = d.id
                and r.ts >= v_start and r.ts < v_end + 1);

  if s.plan = 'pilot' then
    v_lines := v_lines || jsonb_build_object('description', format('TransGuard pilot subscription (up to %s transformers)', s.pilot_max_transformers),
      'quantity', 1, 'unit_price', s.pilot_monthly_fee, 'amount', s.pilot_monthly_fee, 'vat_applies', true, 'category', 'subscription', 'unit', 'month');
    v_sub := s.pilot_monthly_fee;
    v_extra := greatest(0, v_active - s.pilot_max_transformers);
    if v_extra > 0 then
      v_lines := v_lines || jsonb_build_object('description', 'Additional monitored transformers above pilot limit',
        'quantity', v_extra, 'unit_price', s.municipal_unit_price, 'amount', v_extra * s.municipal_unit_price,
        'vat_applies', true, 'category', 'subscription', 'unit', 'transformer');
      v_sub := v_sub + v_extra * s.municipal_unit_price;
    end if;
  else
    v_lines := v_lines || jsonb_build_object('description', format('Monitored transformers (%s plan)', s.plan),
      'quantity', v_active,
      'unit_price', case when s.plan = 'municipal' then s.municipal_unit_price else s.provincial_unit_price end,
      'amount', v_active * case when s.plan = 'municipal' then s.municipal_unit_price else s.provincial_unit_price end,
      'vat_applies', true, 'category', 'subscription', 'unit', 'transformer');
    v_sub := v_active * case when s.plan = 'municipal' then s.municipal_unit_price else s.provincial_unit_price end;
  end if;

  if p_uptime < s.sla_target_pct then
    v_credit := round(v_sub * s.sla_credit_pct / 100, 2);
  end if;
  v_vat := round((v_sub - v_credit) * s.vat_rate, 2);
  v_num := 'TG-' || to_char(v_start, 'YYYYMM') || '-' ||
           lpad(((select count(*) from public.invoices where period_start = v_start and kind = 'subscription') + 1)::text, 2, '0');

  insert into public.invoices (number, period_start, period_end, plan, active_transformers, lines,
    subtotal, sla_uptime_pct, sla_credit, vat, total)
  values (v_num, v_start, v_end, s.plan, v_active, v_lines, v_sub, p_uptime, v_credit, v_vat, v_sub - v_credit + v_vat)
  returning id into v_id;
  perform public._audit('invoice_generated', v_id::text, jsonb_build_object('number', v_num, 'active', v_active, 'total', v_sub - v_credit + v_vat));
  return v_id;
end $$;
