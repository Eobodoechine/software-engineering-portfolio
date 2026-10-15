-- Buyer journey v2: explicit service areas and terms, provider-neutral payment
-- persistence, deterministic local payment work, retry, and authoritative reads.

create table public.farm_service_areas (
  farm_id uuid not null references public.farms(id) on delete cascade,
  postal_code text not null check (postal_code ~ '^\d{5}$'),
  status public.review_status not null default 'PENDING',
  effective_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz,
  version integer not null default 0 check (version >= 0),
  primary key (farm_id, postal_code),
  check (expires_at is null or expires_at > effective_at)
);

create table public.farm_terms (
  farm_id uuid not null references public.farms(id) on delete cascade,
  version text not null check (length(btrim(version)) between 1 and 100),
  title text not null check (length(btrim(title)) between 1 and 160),
  body_text text not null check (length(btrim(body_text)) between 1 and 10000),
  body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  published_at timestamptz not null default clock_timestamp(),
  retired_at timestamptz,
  primary key (farm_id, version),
  check (body_sha256 = encode(extensions.digest(body_text, 'sha256'), 'hex')),
  check (retired_at is null or retired_at >= published_at)
);
create unique index farm_one_current_terms_idx on public.farm_terms (farm_id) where retired_at is null;

create table public.offering_disclosures (
  id uuid primary key default gen_random_uuid(),
  offering_id uuid not null references public.offerings(id) on delete cascade,
  disclosure_type text not null check (disclosure_type in (
    'CANCELLATION_POLICY','PRICE_ADJUSTMENT_POLICY','FULFILLMENT_METHOD','OTHER'
  )),
  label text not null check (length(btrim(label)) between 1 and 160),
  value_text text not null check (length(btrim(value_text)) between 1 and 2000),
  source_name text not null check (length(btrim(source_name)) between 1 and 200),
  source_uri text,
  reviewed_at timestamptz not null,
  expires_at timestamptz,
  version integer not null default 0 check (version >= 0),
  unique (offering_id, disclosure_type),
  check (expires_at is null or expires_at > reviewed_at)
);

alter table public.carts add column destination_postal_code text check (destination_postal_code ~ '^\d{5}$');
alter table public.seller_orders
  add column payment_provider text not null default 'STRIPE' check (payment_provider in ('STRIPE','FAKE'));

create table public.buyer_terms_acceptances (
  id uuid primary key default gen_random_uuid(),
  cart_id uuid not null references public.carts(id) on delete restrict,
  seller_order_id uuid not null references public.seller_orders(id) on delete restrict,
  buyer_user_id uuid not null references auth.users(id) on delete restrict,
  farm_id uuid not null references public.farms(id) on delete restrict,
  terms_version text not null,
  accepted_at timestamptz not null default clock_timestamp(),
  unique (seller_order_id, terms_version),
  foreign key (farm_id, terms_version) references public.farm_terms(farm_id, version) on delete restrict
);

create table private.runtime_settings (
  singleton boolean primary key default true check (singleton),
  fake_payments_enabled boolean not null default false,
  updated_at timestamptz not null default clock_timestamp()
);
insert into private.runtime_settings (singleton, fake_payments_enabled) values (true, false);

create table private.fake_payment_scenarios (
  farm_id uuid primary key references public.farms(id) on delete cascade,
  outcome text not null check (outcome in ('SUCCESS','FAIL','FAIL_ONCE','PENDING')),
  updated_at timestamptz not null default clock_timestamp()
);

alter table public.payment_attempts drop constraint payment_attempts_provider_check;
alter table public.payment_attempts add constraint payment_attempts_provider_check check (provider in ('STRIPE','FAKE'));
alter table public.payment_attempts drop constraint payment_attempts_provider_payment_id_check;
alter table public.payment_attempts add constraint payment_attempts_provider_payment_id_check
  check (provider_payment_id is null or provider_payment_id ~ '^(pi|fake_pi)_[A-Za-z0-9]+$');
alter table public.payment_attempts add column attempt_number integer not null default 1 check (attempt_number > 0);
create unique index payment_attempt_order_generation_idx
  on public.payment_attempts (seller_order_id, attempt_number) where seller_order_id is not null;

alter table public.payment_events drop constraint payment_events_provider_check;
alter table public.payment_events add constraint payment_events_provider_check check (provider in ('STRIPE','FAKE'));
alter table public.payment_events drop constraint payment_events_provider_event_id_check;
alter table public.payment_events add constraint payment_events_provider_event_id_check
  check (provider_event_id ~ '^(evt|fake_evt)_[A-Za-z0-9]+$');

alter table public.farm_service_areas enable row level security;
alter table public.farm_terms enable row level security;
alter table public.offering_disclosures enable row level security;
alter table public.buyer_terms_acceptances enable row level security;
revoke all on public.farm_service_areas, public.farm_terms, public.offering_disclosures, public.buyer_terms_acceptances from anon, authenticated;
create policy farm_service_areas_visible_read on public.farm_service_areas for select to anon, authenticated using (
  status = 'APPROVED' or private.owns_farm(farm_id) or private.is_operator()
);
create policy farm_terms_visible_read on public.farm_terms for select to anon, authenticated using (
  retired_at is null or private.owns_farm(farm_id) or private.is_operator()
);
create policy offering_disclosures_visible_read on public.offering_disclosures for select to anon, authenticated using (
  (expires_at is null or expires_at > clock_timestamp()) and exists (
    select 1 from public.offerings o where o.id = offering_id
      and (o.status = 'PUBLISHED' or private.owns_farm(o.farm_id) or private.is_operator())
  )
);
create policy buyer_terms_acceptances_party_read on public.buyer_terms_acceptances for select to authenticated using (
  buyer_user_id = auth.uid() or private.owns_farm(farm_id) or private.is_operator()
);
grant select on public.farm_service_areas, public.farm_terms, public.offering_disclosures to anon, authenticated;
grant select on public.buyer_terms_acceptances to authenticated;

-- The API service role still needs SQL privileges in addition to its RLS bypass.
-- Keep browser grants unchanged.
grant select on all tables in schema public to service_role;

create or replace function private.fake_payments_enabled()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, private
as $$
  select coalesce((select fake_payments_enabled from private.runtime_settings where singleton), false)
$$;
revoke all on function private.fake_payments_enabled() from public, anon, authenticated;

create or replace function private.offering_evidence_current(p_farm_id uuid, p_processor_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.evidence_records er
    where er.subject_type = 'FARM' and er.subject_id = p_farm_id and er.status = 'APPROVED'
      and (er.effective_at is null or er.effective_at <= clock_timestamp())
      and (er.expires_at is null or er.expires_at > clock_timestamp())
  ) and exists (
    select 1 from public.evidence_records er
    where er.subject_type = 'PROCESSOR' and er.subject_id = p_processor_id and er.status = 'APPROVED'
      and (er.effective_at is null or er.effective_at <= clock_timestamp())
      and (er.expires_at is null or er.expires_at > clock_timestamp())
  )
$$;
revoke all on function private.offering_evidence_current(uuid, uuid) from public, anon, authenticated;

create or replace function public.search_offerings_by_zip_v2(p_postal_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare response jsonb;
begin
  if p_postal_code !~ '^\d{5}$' then
    raise exception using errcode = '22023', message = 'invalid_postal_code';
  end if;
  select jsonb_build_object(
    'postalCode', p_postal_code,
    'coverage', exists (
      select 1 from public.farm_service_areas sa
      where sa.postal_code = p_postal_code and sa.status = 'APPROVED'
        and sa.effective_at <= clock_timestamp() and (sa.expires_at is null or sa.expires_at > clock_timestamp())
    ),
    'offerings', coalesce(jsonb_agg(jsonb_build_object(
      'offeringId', o.id, 'title', o.title, 'farmId', f.id, 'farmName', f.display_name,
      'city', f.city, 'stateCode', f.state_code,
      'availableUnits', greatest(0, o.total_capacity_units - o.committed_units - coalesce(h.active_units, 0)),
      'unitPriceCents', o.unit_price_cents, 'currency', o.currency, 'priceBasis', o.price_basis,
      'shareOptions', coalesce(s.options, '[]'::jsonb), 'version', o.version, 'termsVersion', t.version
    ) order by f.display_name, o.title), '[]'::jsonb)
  ) into response
  from public.offerings o
  join public.farms f on f.id = o.farm_id and f.status = 'APPROVED'
  join public.processors pr on pr.id = o.processor_id and pr.status = 'APPROVED'
    and pr.eligible_through >= current_date
  join public.farm_service_areas sa on sa.farm_id = f.id and sa.postal_code = p_postal_code
    and sa.status = 'APPROVED' and sa.effective_at <= clock_timestamp()
    and (sa.expires_at is null or sa.expires_at > clock_timestamp())
  join public.farm_terms t on t.farm_id = f.id and t.retired_at is null
  left join lateral (
    select sum(ih.units)::integer active_units from public.inventory_holds ih
    where ih.offering_id = o.id and ih.status = 'ACTIVE' and ih.expires_at > clock_timestamp()
  ) h on true
  left join lateral (
    select jsonb_agg(oso.units order by oso.units) options from public.offering_share_options oso
    where oso.offering_id = o.id and oso.enabled
  ) s on true
  where o.status = 'PUBLISHED' and o.evidence_status = 'APPROVED' and o.route_status = 'APPROVED'
    and private.offering_evidence_current(o.farm_id, o.processor_id)
    and o.commitment_deadline_at > clock_timestamp();
  return response;
end;
$$;

create or replace function public.offering_details_v2(p_offering_id uuid, p_postal_code text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare response jsonb;
begin
  if p_postal_code is not null and p_postal_code !~ '^\d{5}$' then
    raise exception using errcode = '22023', message = 'invalid_postal_code';
  end if;
  select jsonb_build_object(
    'offeringId', o.id, 'title', o.title, 'farmId', f.id, 'farmName', f.display_name,
    'city', f.city, 'stateCode', f.state_code,
    'availableUnits', greatest(0, o.total_capacity_units - o.committed_units - coalesce(h.active_units, 0)),
    'unitPriceCents', o.unit_price_cents, 'currency', o.currency, 'priceBasis', o.price_basis,
    'shareOptions', coalesce(s.options, '[]'::jsonb), 'version', o.version,
    'termsVersion', t.version, 'termsTitle', t.title, 'termsBody', t.body_text,
    'processorName', pr.legal_name, 'inspectionRoute', pr.inspection_route,
    'fulfillmentMethods', case when pr.supports_shipping then jsonb_build_array('PROCESSOR_PICKUP','SHIPPING') else jsonb_build_array('PROCESSOR_PICKUP') end,
    'routeEligible', case when p_postal_code is null then null else exists (
      select 1 from public.farm_service_areas sa where sa.farm_id = f.id and sa.postal_code = p_postal_code
        and sa.status = 'APPROVED' and sa.effective_at <= clock_timestamp()
        and (sa.expires_at is null or sa.expires_at > clock_timestamp())
    ) end,
    'estimatedWeightMin', o.estimated_weight_min, 'estimatedWeightMax', o.estimated_weight_max,
    'commitmentDeadlineAt', o.commitment_deadline_at, 'processorCutoffAt', o.processor_cutoff_at,
    'disclosures', coalesce(d.items, '[]'::jsonb)
  ) into response
  from public.offerings o
  join public.farms f on f.id = o.farm_id
  join public.processors pr on pr.id = o.processor_id and pr.status = 'APPROVED' and pr.eligible_through >= current_date
  join public.farm_terms t on t.farm_id = f.id and t.retired_at is null
  left join lateral (
    select sum(ih.units)::integer active_units from public.inventory_holds ih
    where ih.offering_id = o.id and ih.status = 'ACTIVE' and ih.expires_at > clock_timestamp()
  ) h on true
  left join lateral (
    select jsonb_agg(oso.units order by oso.units) options from public.offering_share_options oso
    where oso.offering_id = o.id and oso.enabled
  ) s on true
  left join lateral (
    select jsonb_agg(jsonb_build_object(
      'type', x.disclosure_type, 'label', x.label, 'value', x.value_text,
      'sourceName', x.source_name, 'sourceUri', x.source_uri, 'reviewedAt', x.reviewed_at
    ) order by x.disclosure_type, x.label) items
    from (
      select fc.claim_code disclosure_type, fc.claim_code label, fc.claim_text value_text,
        er.source_name, er.source_uri, er.reviewed_at
      from public.farm_claims fc join public.evidence_records er on er.id = fc.evidence_record_id
      where fc.farm_id = f.id and fc.status = 'APPROVED' and er.status = 'APPROVED'
        and (er.effective_at is null or er.effective_at <= clock_timestamp())
        and (er.expires_at is null or er.expires_at > clock_timestamp())
      union all
      select 'PRICE_BASIS', 'Price basis', o.price_basis,
        'PasturePact offering record', null::text, o.updated_at
      union all
      select 'PROCESSOR_ROUTE', 'Processor and inspection route', pr.legal_name || ' — ' || pr.inspection_route,
        'PasturePact processor record', null::text, pr.updated_at
      union all
      select od.disclosure_type, od.label, od.value_text, od.source_name, od.source_uri, od.reviewed_at
      from public.offering_disclosures od where od.offering_id = o.id
        and (od.expires_at is null or od.expires_at > clock_timestamp())
    ) x
  ) d on true
  where o.id = p_offering_id and o.status = 'PUBLISHED' and f.status = 'APPROVED'
    and o.evidence_status = 'APPROVED' and o.route_status = 'APPROVED'
    and private.offering_evidence_current(o.farm_id, o.processor_id);
  if response is null then raise exception using errcode = 'P0002', message = 'offering_not_found'; end if;
  return response;
end;
$$;

grant execute on function public.search_offerings_by_zip_v2(text) to anon, authenticated;
grant execute on function public.offering_details_v2(uuid, text) to anon, authenticated;

create or replace function public.get_checkout_snapshot_v2(p_cart_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare actor_id uuid := private.require_actor(); response jsonb;
begin
  if not exists (select 1 from public.carts c where c.id = p_cart_id and (c.buyer_user_id = actor_id or private.is_operator(actor_id))) then
    raise exception using errcode = '42501', message = 'checkout_not_accessible';
  end if;
  select jsonb_build_object(
    'cartId', c.id, 'status', c.status, 'currency', c.currency,
    'destinationPostalCode', c.destination_postal_code, 'expiresAt', c.expires_at, 'version', c.version,
    'sellerOrders', coalesce(jsonb_agg(jsonb_build_object(
      'sellerOrderId', so.id, 'farmId', so.farm_id, 'farmName', f.display_name,
      'status', so.status, 'version', so.version, 'subtotalCents', so.subtotal_cents,
      'totalCents', so.total_cents, 'currency', so.currency, 'paymentProvider', so.payment_provider,
      'paymentStatus', coalesce(pa.status::text, 'CREATED'), 'providerPaymentId', pa.provider_payment_id,
      'retryable', so.status in ('FAILED','CANCELLED','EXPIRED'),
      'lines', coalesce(lines.items, '[]'::jsonb), 'acceptedTerms', coalesce(terms.items, '[]'::jsonb)
    ) order by f.display_name), '[]'::jsonb)
  ) into response
  from public.carts c
  left join public.seller_orders so on so.cart_id = c.id
  left join public.farms f on f.id = so.farm_id
  left join lateral (
    select p.* from public.payment_attempts p where p.seller_order_id = so.id
    order by p.attempt_number desc, p.created_at desc limit 1
  ) pa on true
  left join lateral (
    select jsonb_agg(jsonb_build_object(
      'offeringId', ol.offering_id, 'title', o.title, 'units', ol.units,
      'unitPriceCents', ol.unit_price_cents, 'lineTotalCents', ol.line_total_cents
    ) order by o.title) items
    from public.order_lines ol join public.offerings o on o.id = ol.offering_id where ol.seller_order_id = so.id
  ) lines on true
  left join lateral (
    select jsonb_agg(jsonb_build_object(
      'farmId', a.farm_id, 'termsVersion', a.terms_version, 'acceptedAt', a.accepted_at
    ) order by a.accepted_at) items from public.buyer_terms_acceptances a where a.seller_order_id = so.id
  ) terms on true
  where c.id = p_cart_id
  group by c.id;
  return response;
end;
$$;
revoke all on function public.get_checkout_snapshot_v2(uuid) from public, anon;
grant execute on function public.get_checkout_snapshot_v2(uuid) to authenticated;

create or replace function public.start_multi_farm_checkout_v2(
  p_items jsonb,
  p_destination_postal_code text,
  p_hold_minutes integer,
  p_idempotency_key uuid,
  p_request_sha256 text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private
as $$
declare
  actor_id uuid := private.require_actor();
  request_payload jsonb := jsonb_build_object('items', p_items, 'destination_postal_code', p_destination_postal_code, 'hold_minutes', p_hold_minutes);
  replay jsonb; base_result jsonb; cart_id_value uuid; order_row record; provider_value text;
begin
  perform pg_advisory_xact_lock(hashtextextended(actor_id::text || ':' || p_idempotency_key::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('checkout:' || actor_id::text, 0));
  if p_request_sha256 is null then p_request_sha256 := private.sha256_json(request_payload); end if;
  perform private.assert_request_hash(request_payload, p_request_sha256);
  replay := private.command_replay(actor_id, p_idempotency_key, 'start_multi_farm_checkout_v2', p_request_sha256);
  if replay is not null then return replay; end if;
  if p_destination_postal_code !~ '^\d{5}$' then
    raise exception using errcode = '22023', message = 'invalid_postal_code';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 then
    raise exception using errcode = '22023', message = 'checkout_items_required';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_items) i(offering_id uuid, units integer, expected_version integer, terms_version text)
    join public.offerings o on o.id = i.offering_id
    left join public.farm_service_areas sa on sa.farm_id = o.farm_id and sa.postal_code = p_destination_postal_code
      and sa.status = 'APPROVED' and sa.effective_at <= clock_timestamp()
      and (sa.expires_at is null or sa.expires_at > clock_timestamp())
    left join public.farm_terms ft on ft.farm_id = o.farm_id and ft.version = i.terms_version and ft.retired_at is null
    where sa.farm_id is null or ft.farm_id is null or not private.offering_evidence_current(o.farm_id, o.processor_id)
      or (select count(*) from public.offering_disclosures od where od.offering_id = o.id
        and od.disclosure_type in ('CANCELLATION_POLICY','PRICE_ADJUSTMENT_POLICY','FULFILLMENT_METHOD')
        and (od.expires_at is null or od.expires_at > clock_timestamp())) <> 3
  ) then
    raise exception using errcode = '23514', message = 'route_or_terms_not_accepted';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_items) i(offering_id uuid, units integer, expected_version integer, terms_version text)
    group by offering_id having count(distinct terms_version) <> 1 or bool_or(terms_version is null)
  ) then
    raise exception using errcode = '22023', message = 'invalid_terms_acceptance';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_items) i(offering_id uuid)
    join public.inventory_holds h on h.offering_id = i.offering_id and h.owner_user_id = actor_id
      and h.status = 'ACTIVE' and h.expires_at > clock_timestamp() and h.group_order_id is null
    join public.order_lines ol on ol.inventory_hold_id = h.id
  ) then
    raise exception using errcode = '23505', message = 'checkout_already_in_progress';
  end if;
  provider_value := case when private.fake_payments_enabled() then 'FAKE' else 'STRIPE' end;
  base_result := public.start_multi_farm_checkout_v1(
    (select jsonb_agg(jsonb_build_object('offering_id', offering_id, 'units', units, 'expected_version', expected_version))
     from jsonb_to_recordset(p_items) i(offering_id uuid, units integer, expected_version integer, terms_version text)),
    p_hold_minutes, gen_random_uuid(), null
  );
  cart_id_value := (base_result ->> 'cart_id')::uuid;
  update public.carts set destination_postal_code = p_destination_postal_code where id = cart_id_value;
  update public.seller_orders set payment_provider = provider_value where cart_id = cart_id_value;
  for order_row in select so.id, so.farm_id from public.seller_orders so where so.cart_id = cart_id_value loop
    insert into public.buyer_terms_acceptances (cart_id, seller_order_id, buyer_user_id, farm_id, terms_version)
    select cart_id_value, order_row.id, actor_id, order_row.farm_id, i.terms_version
    from jsonb_to_recordset(p_items) i(offering_id uuid, units integer, expected_version integer, terms_version text)
    join public.offerings o on o.id = i.offering_id
    where o.farm_id = order_row.farm_id limit 1;
  end loop;
  replay := public.get_checkout_snapshot_v2(cart_id_value);
  insert into public.command_receipts values (
    actor_id, p_idempotency_key, 'start_multi_farm_checkout_v2', p_request_sha256, replay, clock_timestamp()
  );
  return replay;
end;
$$;
revoke all on function public.start_multi_farm_checkout_v2(jsonb, text, integer, uuid, text) from public, anon;
grant execute on function public.start_multi_farm_checkout_v2(jsonb, text, integer, uuid, text) to authenticated;

create or replace function public.attach_payment_attempt_v2(
  p_seller_order_id uuid,
  p_provider text,
  p_provider_payment_id text,
  p_capture_before timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private
as $$
declare order_row public.seller_orders%rowtype; attempt_row public.payment_attempts%rowtype; next_number integer;
begin
  perform private.require_service_role();
  if p_provider not in ('STRIPE','FAKE') or p_provider_payment_id !~ '^(pi|fake_pi)_[A-Za-z0-9]+$' then
    raise exception using errcode = '22023', message = 'invalid_payment_provider';
  end if;
  select * into order_row from public.seller_orders where id = p_seller_order_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'seller_order_not_found'; end if;
  if order_row.payment_provider <> p_provider then raise exception using errcode = '23514', message = 'seller_order_provider_mismatch'; end if;
  select * into attempt_row from public.payment_attempts where provider_payment_id = p_provider_payment_id;
  if found then
    if attempt_row.seller_order_id is distinct from order_row.id or attempt_row.provider <> p_provider
       or attempt_row.amount_cents <> order_row.total_cents then
      raise exception using errcode = '23505', message = 'payment_attachment_conflict';
    end if;
    return jsonb_build_object('paymentAttemptId', attempt_row.id, 'status', attempt_row.status);
  end if;
  if order_row.status <> 'PENDING_PAYMENT' then raise exception using errcode = '23514', message = 'seller_order_not_awaiting_payment'; end if;
  select coalesce(max(attempt_number), 0) + 1 into next_number from public.payment_attempts where seller_order_id = order_row.id;
  insert into public.payment_attempts (
    seller_order_id, provider, provider_payment_id, connected_account_id, amount_cents, currency, capture_before, attempt_number
  ) values (
    order_row.id, p_provider, p_provider_payment_id, order_row.stripe_connected_account_id,
    order_row.total_cents, order_row.currency, p_capture_before, next_number
  ) returning * into attempt_row;
  return jsonb_build_object('paymentAttemptId', attempt_row.id, 'status', attempt_row.status, 'attemptNumber', next_number);
end;
$$;
revoke all on function public.attach_payment_attempt_v2(uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.attach_payment_attempt_v2(uuid, text, text, timestamptz) to service_role;

create or replace function private.apply_fake_payment_event(
  p_attempt_id uuid,
  p_event_id text,
  p_target_status public.payment_status
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private
as $$
declare attempt_row public.payment_attempts%rowtype; order_row public.seller_orders%rowtype; converted_count integer; cart_status_value public.cart_status;
begin
  select * into attempt_row from public.payment_attempts where id = p_attempt_id for update;
  if not found or attempt_row.provider <> 'FAKE' then raise exception using errcode = '23514', message = 'fake_attempt_required'; end if;
  if exists (select 1 from public.payment_events where provider = 'FAKE' and provider_event_id = p_event_id) then
    return jsonb_build_object('disposition','DUPLICATE','paymentAttemptId',attempt_row.id);
  end if;
  if p_target_status not in ('CAPTURED','FAILED') then raise exception using errcode = '22023', message = 'unsupported_fake_outcome'; end if;
  select * into order_row from public.seller_orders where id = attempt_row.seller_order_id for update;
  if attempt_row.status <> 'CREATED' or order_row.status <> 'PENDING_PAYMENT'
     or attempt_row.attempt_number <> (select max(pa.attempt_number) from public.payment_attempts pa where pa.seller_order_id = order_row.id) then
    insert into public.payment_events (
      provider, provider_event_id, event_type, event_created, livemode, connected_account_id,
      provider_object_id, payload_sha256, payment_attempt_id, disposition
    ) values ('FAKE', p_event_id, 'payment.stale', 1000000 + attempt_row.attempt_number, false,
      attempt_row.connected_account_id, attempt_row.provider_payment_id,
      encode(extensions.digest(p_event_id, 'sha256'), 'hex'), attempt_row.id, 'STALE');
    return jsonb_build_object('disposition','STALE','paymentAttemptId',attempt_row.id);
  end if;
  if p_target_status = 'CAPTURED' and exists (
    select 1 from public.order_lines ol join public.inventory_holds h on h.id = ol.inventory_hold_id
    where ol.seller_order_id = order_row.id and (h.status <> 'ACTIVE' or h.expires_at <= clock_timestamp())
  ) then
    insert into public.payment_events (
      provider, provider_event_id, event_type, event_created, livemode, connected_account_id,
      provider_object_id, payload_sha256, payment_attempt_id, disposition
    ) values ('FAKE', p_event_id, 'payment.succeeded', 1000000 + attempt_row.attempt_number, false,
      attempt_row.connected_account_id, attempt_row.provider_payment_id,
      encode(extensions.digest(p_event_id, 'sha256'), 'hex'), attempt_row.id, 'REJECTED');
    update public.payment_attempts set status = 'FAILED', last_event_created = 1000000 + attempt_number,
      last_event_id = p_event_id, version = version + 1, updated_at = clock_timestamp() where id = attempt_row.id;
    update public.seller_orders set status = 'FAILED', version = version + 1, updated_at = clock_timestamp() where id = order_row.id;
    perform private.enqueue_job('reconcile-order:' || order_row.id::text || ':' || p_event_id,
      'RECONCILE_ORDER', jsonb_build_object('seller_order_id',order_row.id,'reason','fake_capture_after_hold_expiry'));
    cart_status_value := private.project_cart_status(order_row.cart_id);
    return jsonb_build_object('disposition','REJECTED','paymentAttemptId',attempt_row.id,'cartStatus',cart_status_value);
  end if;
  insert into public.payment_events (
    provider, provider_event_id, event_type, event_created, livemode, connected_account_id,
    provider_object_id, payload_sha256, payment_attempt_id, disposition
  ) values (
    'FAKE', p_event_id, case when p_target_status = 'CAPTURED' then 'payment.succeeded' else 'payment.failed' end,
    1000000 + attempt_row.attempt_number, false, attempt_row.connected_account_id,
    attempt_row.provider_payment_id, encode(extensions.digest(p_event_id, 'sha256'), 'hex'), attempt_row.id, 'APPLIED'
  );
  update public.payment_attempts set status = p_target_status, last_event_created = 1000000 + attempt_number,
    last_event_id = p_event_id, version = version + 1, updated_at = clock_timestamp()
  where id = attempt_row.id returning * into attempt_row;
  if p_target_status = 'CAPTURED' then
    with converted as (
      update public.inventory_holds h set status = 'CONVERTED', converted_at = clock_timestamp(),
        version = h.version + 1, updated_at = clock_timestamp()
      from public.order_lines ol where ol.seller_order_id = order_row.id and ol.inventory_hold_id = h.id
        and h.status = 'ACTIVE' and h.expires_at > clock_timestamp()
      returning h.offering_id, h.units
    ), totals as (
      select offering_id, sum(units)::integer units from converted group by offering_id
    )
    update public.offerings o set committed_units = o.committed_units + totals.units,
      version = o.version + 1, updated_at = clock_timestamp() from totals where o.id = totals.offering_id;
    get diagnostics converted_count = row_count;
    if converted_count <> (select count(*) from public.order_lines where seller_order_id = order_row.id) then
      raise exception using errcode = '23514', message = 'fake_capture_without_active_hold';
    end if;
    perform private.post_capture_ledger(order_row.id, p_event_id, attempt_row.amount_cents);
    update public.seller_orders set status = 'PAID', paid_at = clock_timestamp(), version = version + 1,
      updated_at = clock_timestamp() where id = order_row.id;
  else
    update public.inventory_holds h set status = 'RELEASED', released_at = clock_timestamp(),
      release_reason = 'payment_failed', version = h.version + 1, updated_at = clock_timestamp()
    from public.order_lines ol where ol.seller_order_id = order_row.id and ol.inventory_hold_id = h.id and h.status = 'ACTIVE';
    update public.seller_orders set status = 'FAILED', version = version + 1, updated_at = clock_timestamp() where id = order_row.id;
  end if;
  cart_status_value := private.project_cart_status(order_row.cart_id);
  perform private.append_audit_event('SELLER_ORDER', order_row.id, order_row.version + 1,
    'PAYMENT_' || p_target_status::text, null, 'PROVIDER', 'FAKE_PROVIDER',
    jsonb_build_object('provider_event_id',p_event_id,'payment_attempt_id',attempt_row.id,'amount_cents',attempt_row.amount_cents));
  return jsonb_build_object('disposition','APPLIED','paymentAttemptId',attempt_row.id,
    'paymentStatus',p_target_status,'cartStatus',cart_status_value);
end;
$$;
revoke all on function private.apply_fake_payment_event(uuid, text, public.payment_status) from public, anon, authenticated;

create or replace function public.process_fake_payment_job_v1(
  p_job_id uuid,
  p_worker_id text,
  p_claim_version integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private
as $$
declare job_row public.outbox_jobs%rowtype; order_row public.seller_orders%rowtype; attempt jsonb; attempt_id uuid;
  scenario text; target public.payment_status; provider_id text; event_id text; result jsonb;
begin
  perform private.require_service_role();
  if not private.fake_payments_enabled() then raise exception using errcode = '42501', message = 'fake_payments_disabled'; end if;
  select * into job_row from public.outbox_jobs where id = p_job_id for update;
  if not found or job_row.kind <> 'CREATE_PAYMENT' then raise exception using errcode = 'P0002', message = 'fake_payment_job_not_found'; end if;
  if job_row.status <> 'LEASED' or job_row.leased_by <> p_worker_id or job_row.claim_version <> p_claim_version
     or job_row.lease_expires_at <= clock_timestamp() then
    raise exception using errcode = '40001', message = 'stale_outbox_completion';
  end if;
  select * into order_row from public.seller_orders where id = (job_row.payload ->> 'seller_order_id')::uuid for update;
  if order_row.payment_provider <> 'FAKE' then raise exception using errcode = '23514', message = 'fake_job_provider_mismatch'; end if;
  provider_id := 'fake_pi_' || replace(job_row.id::text, '-', '');
  event_id := 'fake_evt_' || replace(job_row.id::text, '-', '');
  attempt := public.attach_payment_attempt_v2(order_row.id, 'FAKE', provider_id, null);
  attempt_id := (attempt ->> 'paymentAttemptId')::uuid;
  select coalesce(fps.outcome, 'SUCCESS') into scenario from private.fake_payment_scenarios fps where fps.farm_id = order_row.farm_id;
  if scenario = 'PENDING' then
    result := jsonb_build_object('disposition','PENDING','paymentAttemptId',attempt_id);
  else
    target := case when scenario = 'FAIL' or (scenario = 'FAIL_ONCE' and (attempt ->> 'attemptNumber')::integer = 1)
      then 'FAILED'::public.payment_status else 'CAPTURED'::public.payment_status end;
    result := private.apply_fake_payment_event(attempt_id, event_id, target);
  end if;
  update public.outbox_jobs set status = 'DELIVERED', lease_expires_at = null, leased_by = null,
    last_error_code = null, updated_at = clock_timestamp() where id = job_row.id;
  return result;
end;
$$;
revoke all on function public.process_fake_payment_job_v1(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.process_fake_payment_job_v1(uuid, text, integer) to service_role;

create or replace function public.retry_seller_order_v2(
  p_seller_order_id uuid,
  p_expected_version integer,
  p_terms_version text,
  p_idempotency_key uuid,
  p_request_sha256 text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private
as $$
declare actor_id uuid := private.require_actor(); order_row public.seller_orders%rowtype; cart_row public.carts%rowtype;
  line_row record; offering_row public.offerings%rowtype; active_units integer; hold_id_value uuid; replay jsonb;
  request_payload jsonb := jsonb_build_object('seller_order_id',p_seller_order_id,'expected_version',p_expected_version,'terms_version',p_terms_version);
begin
  perform pg_advisory_xact_lock(hashtextextended(actor_id::text || ':' || p_idempotency_key::text, 0));
  if p_request_sha256 is null then p_request_sha256 := private.sha256_json(request_payload); end if;
  perform private.assert_request_hash(request_payload, p_request_sha256);
  replay := private.command_replay(actor_id,p_idempotency_key,'retry_seller_order_v2',p_request_sha256);
  if replay is not null then return replay; end if;
  select * into order_row from public.seller_orders where id = p_seller_order_id for update;
  if not found or order_row.buyer_user_id <> actor_id then raise exception using errcode = '42501', message = 'seller_order_not_accessible'; end if;
  if order_row.version <> p_expected_version then raise exception using errcode = '40001', message = 'seller_order_version_conflict'; end if;
  if order_row.status not in ('FAILED','CANCELLED','EXPIRED') then raise exception using errcode = '23514', message = 'seller_order_not_retryable'; end if;
  select * into cart_row from public.carts where id = order_row.cart_id for update;
  if not exists (select 1 from public.farm_terms where farm_id = order_row.farm_id and version = p_terms_version and retired_at is null)
     or not exists (select 1 from public.farm_service_areas where farm_id = order_row.farm_id
       and postal_code = cart_row.destination_postal_code and status = 'APPROVED'
       and effective_at <= clock_timestamp() and (expires_at is null or expires_at > clock_timestamp())) then
    raise exception using errcode = '23514', message = 'route_or_terms_not_accepted';
  end if;
  for line_row in select * from public.order_lines where seller_order_id = order_row.id order by offering_id loop
    select o.* into offering_row from public.offerings o
      join public.farms f on f.id = o.farm_id and f.status = 'APPROVED'
      join public.processors pr on pr.id = o.processor_id and pr.status = 'APPROVED' and pr.eligible_through >= current_date
      where o.id = line_row.offering_id for update of o;
    if not found then raise exception using errcode = '23514', message = 'retry_partner_ineligible'; end if;
    perform * from private.expire_offering_holds(offering_row.id, clock_timestamp());
    select coalesce(sum(units),0)::integer into active_units from public.inventory_holds
      where offering_id = offering_row.id and status = 'ACTIVE';
    if offering_row.status <> 'PUBLISHED' or offering_row.evidence_status <> 'APPROVED'
       or offering_row.route_status <> 'APPROVED' or offering_row.commitment_deadline_at <= clock_timestamp()
       or not private.offering_evidence_current(offering_row.farm_id, offering_row.processor_id)
       or not exists (select 1 from public.offering_share_options oso where oso.offering_id = offering_row.id
         and oso.units = line_row.units and oso.enabled)
       or (select count(*) from public.offering_disclosures od where od.offering_id = offering_row.id
         and od.disclosure_type in ('CANCELLATION_POLICY','PRICE_ADJUSTMENT_POLICY','FULFILLMENT_METHOD')
         and (od.expires_at is null or od.expires_at > clock_timestamp())) <> 3
       or offering_row.unit_price_cents <> line_row.unit_price_cents
       or offering_row.total_capacity_units - offering_row.committed_units - active_units < line_row.units then
      raise exception using errcode = '23514', message = 'retry_offering_unavailable_or_changed';
    end if;
    insert into public.inventory_holds(offering_id,owner_user_id,units,expires_at)
      values (offering_row.id,actor_id,line_row.units,least(clock_timestamp()+interval '20 minutes',offering_row.commitment_deadline_at))
      returning id into hold_id_value;
    update public.order_lines set inventory_hold_id = hold_id_value where id = line_row.id;
  end loop;
  update public.seller_orders set status = 'PENDING_PAYMENT', payment_provider = order_row.payment_provider,
    version = version + 1, updated_at = clock_timestamp() where id = order_row.id;
  update public.carts set status = 'CHECKOUT', expires_at = clock_timestamp()+interval '20 minutes',
    version = version + 1, updated_at = clock_timestamp() where id = cart_row.id;
  insert into public.buyer_terms_acceptances(cart_id,seller_order_id,buyer_user_id,farm_id,terms_version)
    values(cart_row.id,order_row.id,actor_id,order_row.farm_id,p_terms_version) on conflict do nothing;
  perform private.enqueue_job('create-payment:'||order_row.id::text||':retry:'||(order_row.version+1)::text,
    'CREATE_PAYMENT',jsonb_build_object('seller_order_id',order_row.id,'cart_id',cart_row.id,'retry',true));
  replay := public.get_checkout_snapshot_v2(cart_row.id);
  insert into public.command_receipts values(actor_id,p_idempotency_key,'retry_seller_order_v2',p_request_sha256,replay,clock_timestamp());
  return replay;
end;
$$;
revoke all on function public.retry_seller_order_v2(uuid, integer, text, uuid, text) from public, anon;
grant execute on function public.retry_seller_order_v2(uuid, integer, text, uuid, text) to authenticated;
