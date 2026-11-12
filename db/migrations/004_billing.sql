-- Billing: monthly invoices to Eskom, priced per active transformer
-- Active transformer = a transformer whose sensor sent at least one reading in the month.

create table public.billing_settings (
  id                      int primary key default 1 check (id = 1),
  plan                    text not null default 'pilot' check (plan in ('pilot','municipal','provincial')),
  pilot_monthly_fee       numeric(12,2) not null default 18000,
  pilot_max_transformers  int not null default 20,
  municipal_unit_price    numeric(12,2) not null default 650,
  provincial_unit_price   numeric(12,2) not null default 450,
  vat_rate                numeric(5,4) not null default 0.15,
  payment_terms_days      int not null default 30,
  sla_target_pct          numeric(6,3) not null default 99.9,
  sla_credit_pct          numeric(5,2) not null default 10,
  customer_name           text not null default 'Eskom Holdings SOC Ltd',
  customer_details        text not null default '[Customer address, VAT number, purchase order number]',
  supplier_name           text not null default 'TransGuard',
  supplier_details        text not null default '[Company registration number, VAT number, address, email]',
  bank_details            text not null default '[Bank name, account name, account number, branch code]',
  updated_at              timestamptz not null default now()
);
insert into public.billing_settings (id) values (1);

create table public.invoices (
  id                  uuid primary key default gen_random_uuid(),
  number              text not null unique,
  period_start        date not null,
  period_end          date not null,
  plan                text not null,
  active_transformers int not null,
  lines               jsonb not null,           -- [{description, quantity, unit_price, amount}]
  subtotal            numeric(12,2) not null,
  sla_uptime_pct      numeric(6,3) not null default 100,
  sla_credit          numeric(12,2) not null default 0,
  vat                 numeric(12,2) not null,
  total               numeric(12,2) not null,
  status              text not null default 'draft' check (status in ('draft','issued','paid','overdue','void')),
  created_at          timestamptz not null default now(),
  issued_at           timestamptz,
  due_at              date,
  paid_at             timestamptz,
  payment_reference   text,
  notes               text
);
create unique index invoices_one_per_month on public.invoices (period_start) where status <> 'void';

alter table public.billing_settings enable row level security;
alter table public.invoices enable row level security;

create policy "billing settings readers" on public.billing_settings for select to authenticated
  using (public.my_role() in ('system_admin','eskom_operator'));
create policy "sysadmin edits billing settings" on public.billing_settings for update to authenticated
  using (public.my_role() = 'system_admin') with check (public.my_role() = 'system_admin');
create policy "invoice readers" on public.invoices for select to authenticated
  using (public.my_role() in ('system_admin','eskom_operator'));

-- Generate the invoice for the month containing p_month (draft)
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
  if exists (select 1 from public.invoices where period_start = v_start and status <> 'void') then
    raise exception 'an invoice for % already exists (void it first to regenerate)', to_char(v_start, 'Mon YYYY');
  end if;
  select * into s from public.billing_settings where id = 1;

  select count(distinct d.transformer_id) into v_active
  from public.devices d
  where exists (select 1 from public.readings r where r.device_id = d.id
                and r.ts >= v_start and r.ts < v_end + 1);

  if s.plan = 'pilot' then
    v_lines := v_lines || jsonb_build_object('description', format('TransGuard pilot subscription (up to %s transformers)', s.pilot_max_transformers),
      'quantity', 1, 'unit_price', s.pilot_monthly_fee, 'amount', s.pilot_monthly_fee);
    v_sub := s.pilot_monthly_fee;
    v_extra := greatest(0, v_active - s.pilot_max_transformers);
    if v_extra > 0 then
      v_lines := v_lines || jsonb_build_object('description', 'Additional monitored transformers above pilot limit',
        'quantity', v_extra, 'unit_price', s.municipal_unit_price, 'amount', v_extra * s.municipal_unit_price);
      v_sub := v_sub + v_extra * s.municipal_unit_price;
    end if;
  else
    v_lines := v_lines || jsonb_build_object('description', format('Monitored transformers (%s plan)', s.plan),
      'quantity', v_active,
      'unit_price', case when s.plan = 'municipal' then s.municipal_unit_price else s.provincial_unit_price end,
      'amount', v_active * case when s.plan = 'municipal' then s.municipal_unit_price else s.provincial_unit_price end);
    v_sub := v_active * case when s.plan = 'municipal' then s.municipal_unit_price else s.provincial_unit_price end;
  end if;

  if p_uptime < s.sla_target_pct then
    v_credit := round(v_sub * s.sla_credit_pct / 100, 2);
  end if;
  v_vat := round((v_sub - v_credit) * s.vat_rate, 2);
  v_num := 'TG-' || to_char(v_start, 'YYYYMM') || '-' ||
           lpad(((select count(*) from public.invoices where period_start = v_start) + 1)::text, 2, '0');

  insert into public.invoices (number, period_start, period_end, plan, active_transformers, lines,
    subtotal, sla_uptime_pct, sla_credit, vat, total)
  values (v_num, v_start, v_end, s.plan, v_active, v_lines, v_sub, p_uptime, v_credit, v_vat, v_sub - v_credit + v_vat)
  returning id into v_id;
  perform public._audit('invoice_generated', v_id::text, jsonb_build_object('number', v_num, 'active', v_active, 'total', v_sub - v_credit + v_vat));
  return v_id;
end $$;

create or replace function public.issue_invoice(p_invoice uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v public.invoices; t int;
begin
  perform public._require_role(array['system_admin']);
  select * into v from public.invoices where id = p_invoice for update;
  if v.status <> 'draft' then raise exception 'invoice is %, expected draft', v.status; end if;
  select payment_terms_days into t from public.billing_settings where id = 1;
  update public.invoices set status = 'issued', issued_at = now(), due_at = current_date + t where id = p_invoice;
  perform public._audit('invoice_issued', p_invoice::text, jsonb_build_object('number', v.number));
end $$;

create or replace function public.mark_invoice_paid(p_invoice uuid, p_reference text)
returns void language plpgsql security definer set search_path = '' as $$
declare v public.invoices;
begin
  perform public._require_role(array['system_admin']);
  select * into v from public.invoices where id = p_invoice for update;
  if v.status not in ('issued','overdue') then raise exception 'invoice is %, cannot mark paid', v.status; end if;
  update public.invoices set status = 'paid', paid_at = now(), payment_reference = left(p_reference, 100) where id = p_invoice;
  perform public._audit('invoice_paid', p_invoice::text, jsonb_build_object('number', v.number, 'reference', left(p_reference, 100)));
end $$;

create or replace function public.void_invoice(p_invoice uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare v public.invoices;
begin
  perform public._require_role(array['system_admin']);
  select * into v from public.invoices where id = p_invoice for update;
  if v.status not in ('draft','issued','overdue') then raise exception 'invoice is %, cannot void', v.status; end if;
  update public.invoices set status = 'void', notes = left(p_reason, 300) where id = p_invoice;
  perform public._audit('invoice_voided', p_invoice::text, jsonb_build_object('number', v.number, 'reason', left(p_reason, 300)));
end $$;

create or replace function public.mark_overdue_invoices()
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  update public.invoices set status = 'overdue' where status = 'issued' and due_at < current_date;
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function public.generate_invoice(date, numeric) from public, anon;
revoke execute on function public.issue_invoice(uuid) from public, anon;
revoke execute on function public.mark_invoice_paid(uuid, text) from public, anon;
revoke execute on function public.void_invoice(uuid, text) from public, anon;
revoke execute on function public.mark_overdue_invoices() from public, anon, authenticated;
grant execute on function public.generate_invoice(date, numeric) to authenticated;
grant execute on function public.issue_invoice(uuid) to authenticated;
grant execute on function public.mark_invoice_paid(uuid, text) to authenticated;
grant execute on function public.void_invoice(uuid, text) to authenticated;

select cron.schedule('transguard-overdue-invoices', '15 0 * * *', $$select public.mark_overdue_invoices()$$);
