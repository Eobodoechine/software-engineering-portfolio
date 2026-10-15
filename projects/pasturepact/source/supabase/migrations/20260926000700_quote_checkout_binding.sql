-- W04: a REAL checkout must consume each buyer's current fixed all-in quote.
-- The existing platform-fee column is the provider application fee. For these
-- orders, subtotal = farm source + buyer fee, so farmer proceeds remain source.
begin;

-- The W01 shared trigger must access the namespace column only on payment
-- attempts; seller_orders intentionally has no such column.
create or replace function private.enforce_provider_lane_snapshot()
returns trigger language plpgsql set search_path=pg_catalog,public,private as $$
declare expected_configuration uuid; expected_target public.payment_target; expected_mode public.experience_mode;
  expected_namespace uuid;
begin
  if tg_op='UPDATE' then
    if old.provider_configuration_version_id is not null and
      (new.provider_configuration_version_id is distinct from old.provider_configuration_version_id
       or new.payment_target is distinct from old.payment_target) then
      raise exception using errcode='23514',message='provider_lane_immutable';
    end if;
    if tg_table_name='payment_attempts' then
      if old.provider_configuration_version_id is not null and
        new.provider_namespace_id is distinct from old.provider_namespace_id then
        raise exception using errcode='23514',message='provider_lane_immutable';
      end if;
    end if;
    if new.experience_mode is distinct from old.experience_mode then
      raise exception using errcode='23514',message='experience_mode_immutable';
    end if;
  end if;
  if tg_table_name='payment_attempts' then
    if new.seller_order_id is not null then
      select provider_configuration_version_id,payment_target,experience_mode
      into expected_configuration,expected_target,expected_mode from public.seller_orders where id=new.seller_order_id;
    else
      select so.provider_configuration_version_id,so.payment_target,so.experience_mode
      into expected_configuration,expected_target,expected_mode from public.group_members gm
      join public.seller_orders so on so.group_order_id=gm.group_order_id where gm.id=new.group_member_id;
    end if;
    if expected_configuration is not null then
      if new.provider_configuration_version_id is not null and new.provider_configuration_version_id<>expected_configuration then
        raise exception using errcode='23514',message='provider_lane_mismatch';
      end if;
      new.provider_configuration_version_id:=expected_configuration; new.payment_target:=expected_target;
    end if;
  end if;
  if new.provider_configuration_version_id is not null then
    select c.provider_namespace_id into expected_namespace from public.provider_configuration_versions c
      join public.provider_namespaces n on n.id=c.provider_namespace_id
      where c.id=new.provider_configuration_version_id and c.payment_target=new.payment_target
        and c.experience_mode=new.experience_mode and n.experience_mode=new.experience_mode;
    if expected_namespace is null then
      raise exception using errcode='23514',message='provider_lane_mismatch';
    end if;
    if tg_table_name='payment_attempts' then
      if new.provider_namespace_id is not null and new.provider_namespace_id<>expected_namespace then
        raise exception using errcode='23514',message='provider_lane_mismatch';
      end if;
      new.provider_namespace_id:=expected_namespace;
    end if;
  end if;
  return new;
end;
$$;

alter table public.order_lines
  add column accepted_quote_id uuid references public.accepted_buyer_quotes(id) on delete restrict;
alter table public.seller_orders
  add column quote_source_cents bigint check (quote_source_cents>=0),
  add column quote_buyer_fee_cents bigint check (quote_buyer_fee_cents>=0),
  add constraint seller_order_quote_components_match check (
    (quote_source_cents is null and quote_buyer_fee_cents is null)
    or (quote_source_cents is not null and quote_buyer_fee_cents is not null
      and subtotal_cents=quote_source_cents+quote_buyer_fee_cents
      and platform_fee_cents=quote_buyer_fee_cents));

-- A newer charge version cannot land between the version check and order bind.
create function private.lock_route_charge_version_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'quote-charge:'||new.offering_id::text||':'||new.destination_postal_code||':'||new.fulfillment_route,0));
  return new;
end $$;
create trigger lock_route_charge_version before insert on public.route_charge_versions
  for each row execute function private.lock_route_charge_version_v1();

alter function public.start_multi_farm_checkout_v3(jsonb,text,integer,uuid,text)
  rename to start_multi_farm_checkout_v3_w04_pre_quote;

create function public.start_multi_farm_checkout_v3(
  p_items jsonb,p_destination_postal_code text,p_hold_minutes integer,p_idempotency_key uuid,
  p_request_sha256 text default null
) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,public,private as $$
declare actor uuid:=private.require_actor(); item record; quote_row public.accepted_buyer_quotes%rowtype;
  fresh jsonb; final_response jsonb; replay jsonb; cart_id_value uuid; order_row record;
  source_cents bigint; line_source_cents bigint; processing_cents bigint; route_cents bigint;
  quoted_tax_cents bigint; buyer_fee_cents bigint; quoted_total_cents bigint; actual_total_cents bigint;
  changed integer;
  request_payload jsonb:=jsonb_build_object('items',p_items,'destination_postal_code',p_destination_postal_code,
    'hold_minutes',p_hold_minutes);
begin
  perform pg_advisory_xact_lock(hashtextextended(actor::text||':'||p_idempotency_key::text,0));
  if p_request_sha256 is null then p_request_sha256:=private.sha256_json(request_payload); end if;
  perform private.assert_request_hash(request_payload,p_request_sha256);
  replay:=private.command_replay(actor,p_idempotency_key,'start_multi_farm_checkout_v3',p_request_sha256);
  if replay is not null then return replay; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)<1 then
    raise exception using errcode='22023',message='checkout_items_required'; end if;
  if p_destination_postal_code !~ '^[0-9]{5}$' then
    raise exception using errcode='22023',message='invalid_postal_code'; end if;
  if exists(select 1 from jsonb_to_recordset(p_items) i(offering_id uuid,fulfillment_route text)
    left join public.offerings o on o.id=i.offering_id where o.id is null or o.experience_mode<>'REAL') then
    raise exception using errcode='42501',message='offering_unavailable'; end if;
  -- Preserve W01 release admission ahead of the new price contract.
  for item in select distinct fulfillment_route from jsonb_to_recordset(p_items)
      i(offering_id uuid,fulfillment_route text) order by fulfillment_route loop
    perform private.request_experience_release('REAL',p_destination_postal_code||':'||item.fulfillment_route);
  end loop;
  if exists(select 1 from jsonb_to_recordset(p_items) i(fulfillment_route text)
    where i.fulfillment_route is null or i.fulfillment_route not in ('PROCESSOR_DIRECT','PROCESSOR_PICKUP')) then
    raise exception using errcode='22023',message='explicit_fulfillment_route_required'; end if;
  if exists(select 1 from jsonb_to_recordset(p_items) i(offering_id uuid,fulfillment_route text)
    join public.offerings o on o.id=i.offering_id
    left join public.farm_service_areas sa on sa.farm_id=o.farm_id
      and sa.postal_code=p_destination_postal_code and sa.fulfillment_route=i.fulfillment_route
      and sa.status='APPROVED' and sa.effective_at<=clock_timestamp()
      and (sa.expires_at is null or sa.expires_at>clock_timestamp())
    where sa.farm_id is null) then
    raise exception using errcode='23514',message='selected_route_not_approved_for_destination'; end if;
  -- Lock offerings in a fixed order so farmer price edits cannot race a bind.
  for item in select distinct offering_id from jsonb_to_recordset(p_items)
      i(offering_id uuid) order by offering_id loop
    perform 1 from public.offerings where id=item.offering_id for update;
  end loop;
  for item in select offering_id,units,expected_version,fulfillment_route,accepted_quote_id
      from jsonb_to_recordset(p_items)
      i(offering_id uuid,units integer,expected_version integer,fulfillment_route text,accepted_quote_id uuid)
      order by offering_id loop
    perform pg_advisory_xact_lock(hashtextextended(
      'quote-charge:'||item.offering_id::text||':'||p_destination_postal_code||':'||item.fulfillment_route,0));
    if item.accepted_quote_id is null then
      raise exception using errcode='23514',message='accepted_quote_required'; end if;
    select * into quote_row from public.accepted_buyer_quotes where id=item.accepted_quote_id;
    if not found or quote_row.buyer_user_id<>actor or quote_row.offering_id<>item.offering_id
       or quote_row.units<>item.units or quote_row.experience_mode<>'REAL'
       or quote_row.quote_snapshot->>'destinationPostalCode'<>p_destination_postal_code
       or quote_row.quote_snapshot->>'fulfillmentRoute'<>item.fulfillment_route then
      raise exception using errcode='42501',message='accepted_quote_unavailable'; end if;
    fresh:=public.preview_buyer_quote_v1(item.offering_id,item.units,p_destination_postal_code,item.fulfillment_route);
    if quote_row.quote_version<>fresh->>'quoteVersion'
       or quote_row.quote_snapshot is distinct from fresh
       or (fresh->>'offeringVersion')::integer is distinct from item.expected_version then
      raise exception using errcode='40001',message='stale_quote_review_required'; end if;
    if (fresh->>'guaranteed')::boolean is not true
       or fresh->>'totalCents' is null
       or (fresh->'components'->>'adjustment')::bigint<>0 then
      raise exception using errcode='23514',message='final_quote_required'; end if;
  end loop;

  final_response:=public.start_multi_farm_checkout_v3_w04_pre_quote(
    p_items,p_destination_postal_code,p_hold_minutes,p_idempotency_key,p_request_sha256);
  cart_id_value:=(final_response->>'cartId')::uuid;
  update public.order_lines ol set accepted_quote_id=i.accepted_quote_id
    from public.seller_orders so,
      jsonb_to_recordset(p_items) i(offering_id uuid,accepted_quote_id uuid)
    where ol.seller_order_id=so.id and so.cart_id=cart_id_value and ol.offering_id=i.offering_id;
  get diagnostics changed=row_count;
  if changed<>jsonb_array_length(p_items) then
    raise exception using errcode='23514',message='quote_order_line_mismatch'; end if;
  for order_row in select id from public.seller_orders where cart_id=cart_id_value order by id loop
    select sum((q.quote_snapshot->'components'->>'source')::bigint),sum(ol.line_total_cents),
      sum((q.quote_snapshot->'components'->>'processing')::bigint),
      sum((q.quote_snapshot->'components'->>'shippingOrPickup')::bigint),
      sum((q.quote_snapshot->'components'->>'tax')::bigint),
      sum((q.quote_snapshot->'components'->>'buyerFee')::bigint),
      sum((q.quote_snapshot->>'totalCents')::bigint)
      into source_cents,line_source_cents,processing_cents,route_cents,quoted_tax_cents,buyer_fee_cents,quoted_total_cents
      from public.order_lines ol join public.accepted_buyer_quotes q on q.id=ol.accepted_quote_id
      where ol.seller_order_id=order_row.id;
    if source_cents is null or source_cents<>line_source_cents then
      raise exception using errcode='23514',message='quote_source_mismatch'; end if;
    update public.seller_orders set subtotal_cents=source_cents+buyer_fee_cents,
      platform_fee_cents=buyer_fee_cents,processor_cents=processing_cents,
      shipping_cents=route_cents,tax_cents=quoted_tax_cents,
      quote_source_cents=source_cents,quote_buyer_fee_cents=buyer_fee_cents,
      updated_at=clock_timestamp() where id=order_row.id;
    select total_cents into actual_total_cents from public.seller_orders where id=order_row.id;
    if actual_total_cents<>quoted_total_cents then
      raise exception using errcode='23514',message='quote_order_total_mismatch'; end if;
    perform private.append_audit_event('SELLER_ORDER',order_row.id,0,'ALL_IN_QUOTE_BOUND',actor,'BUYER',
      'Current guaranteed quote',jsonb_build_object('sourceCents',source_cents,
      'buyerFeeCents',buyer_fee_cents,'processingCents',processing_cents,
      'routeCents',route_cents,'taxCents',quoted_tax_cents,'totalCents',actual_total_cents));
  end loop;
  final_response:=public.get_checkout_snapshot_v3(cart_id_value);
  update public.command_receipts set response=final_response
    where actor_user_id=actor and idempotency_key=p_idempotency_key
      and command_name='start_multi_farm_checkout_v3' and request_sha256=p_request_sha256;
  get diagnostics changed=row_count;
  if changed<>1 then raise exception using errcode='23514',message='checkout_receipt_missing'; end if;
  return final_response;
end $$;

revoke all on function public.start_multi_farm_checkout_v3_w04_pre_quote(jsonb,text,integer,uuid,text),
  private.lock_route_charge_version_v1() from public,anon,authenticated,service_role;
revoke all on function public.start_multi_farm_checkout_v3(jsonb,text,integer,uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function public.start_multi_farm_checkout_v3(jsonb,text,integer,uuid,text) to authenticated,service_role;
commit;
