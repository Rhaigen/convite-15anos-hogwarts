-- Esquema do banco do convite (Supabase / Postgres), gerado por `npm run db:schema`.
-- Resultado das 19 migrações de supabase/migrations/ (fonte de verdade). Só estrutura.
-- Nenhuma tabela é acessível a `anon`/`authenticated`: tudo passa pelas funções `bot_*`,
-- executadas só pelas Edge Functions com `service_role`.

set check_function_bodies = off;

-- ============================================================================
-- Extensões
-- ============================================================================

create extension if not exists "pg_trgm" with schema extensions;
create extension if not exists "pg_cron" with schema extensions;
create extension if not exists "pg_net" with schema extensions;
create extension if not exists "fuzzystrmatch" with schema extensions;

-- ============================================================================
-- Funções
-- ============================================================================

CREATE OR REPLACE FUNCTION public.admin_import_guests(p_rows jsonb, p_apply boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_errors jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_row record;
  v_household_id uuid;
  v_inserted integer := 0;
  v_updated integer := 0;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    return jsonb_build_object('ok', false, 'errors', jsonb_build_array('planilha vazia'));
  end if;

  drop table if exists pg_temp.import_rows;
  create temporary table import_rows on commit drop as
  select r.ord::integer as line,
         btrim(regexp_replace(coalesce(r.v ->> 'household', ''), '\s+', ' ', 'g')) as household,
         btrim(regexp_replace(coalesce(r.v ->> 'full_name', ''), '\s+', ' ', 'g')) as full_name,
         public.normalize_name(r.v ->> 'full_name') as name_search,
         nullif(btrim(coalesce(r.v ->> 'phone', '')), '') as phone_raw,
         public.normalize_phone(r.v ->> 'phone') as phone,
         nullif(btrim(coalesce(r.v ->> 'relationship', '')), '') as relationship,
         coalesce((r.v ->> 'is_minor')::boolean, false) as is_minor,
         coalesce((r.v ->> 'can_answer_for_household')::boolean, not coalesce((r.v ->> 'is_minor')::boolean, false))
           as can_answer,
         false as phone_kept
    from jsonb_array_elements(p_rows) with ordinality as r(v, ord);

  -- Telefone corrigido pelos organizadores (pedido aceito): a planilha que ainda
  -- traz o telefone antigo não o desfaz. Telefone diferente do antigo vale.
  update pg_temp.import_rows r
     set phone = g.phone_e164, phone_kept = true
    from public.guests g
    join public.households h on h.id = g.household_id
   where h.label = r.household
     and g.name_search = r.name_search
     and g.phone_e164 is distinct from r.phone
     and exists (
       select 1 from public.identity_requests q
        where q.status = 'accepted'
          and q.resolved_guest_id = g.id
          and q.previous_phone is not distinct from r.phone);

  -- Erros: impedem a importação.
  for v_row in select * from pg_temp.import_rows order by line loop
    if char_length(v_row.household) < 2 then
      v_errors := v_errors || to_jsonb(format('linha %s: família em branco', v_row.line));
    end if;
    if char_length(v_row.full_name) < 2 or char_length(v_row.full_name) > 120 then
      v_errors := v_errors || to_jsonb(format('linha %s: nome inválido', v_row.line));
    end if;
    if v_row.phone_raw is not null and v_row.phone is null then
      v_errors := v_errors || to_jsonb(format('linha %s: telefone inválido (%s)', v_row.line, v_row.phone_raw));
    end if;
    if v_row.is_minor and v_row.can_answer then
      v_errors := v_errors || to_jsonb(format('linha %s: menor de idade não pode responder pela família (%s)', v_row.line, v_row.full_name));
    end if;
  end loop;

  for v_row in
    select phone, string_agg(full_name, ', ' order by line) as names
      from pg_temp.import_rows where phone is not null group by phone having count(*) > 1
  loop
    v_errors := v_errors || to_jsonb(format('telefone repetido %s: %s', v_row.phone, v_row.names));
  end loop;

  for v_row in
    select household, name_search, string_agg(line::text, ', ' order by line) as lines
      from pg_temp.import_rows group by household, name_search having count(*) > 1
  loop
    v_errors := v_errors || to_jsonb(format('nome repetido na mesma família (linhas %s)', v_row.lines));
  end loop;

  for v_row in
    select r.full_name, g.full_name as other_name
      from pg_temp.import_rows r
      join public.guests g on g.phone_e164 = r.phone
      join public.households h on h.id = g.household_id
     where not (h.label = r.household and g.name_search = r.name_search)
  loop
    v_errors := v_errors || to_jsonb(format('telefone de %s já pertence a %s no banco', v_row.full_name, v_row.other_name));
  end loop;

  -- Avisos: não impedem, mas merecem revisão.
  for v_row in select full_name, household from pg_temp.import_rows where phone_kept order by line loop
    v_warnings := v_warnings || to_jsonb(format(
      'telefone corrigido pelos organizadores mantido: %s — %s (a planilha ainda tem o número antigo)',
      v_row.full_name, v_row.household));
  end loop;

  for v_row in
    select household from pg_temp.import_rows group by household
    having not bool_or(phone is not null and can_answer)
  loop
    v_warnings := v_warnings || to_jsonb(format('família sem adulto com telefone: %s (só por busca de nome)', v_row.household));
  end loop;

  for v_row in
    select name_search, string_agg(household, ', ' order by household) as households
      from pg_temp.import_rows group by name_search having count(distinct household) > 1
  loop
    v_warnings := v_warnings || to_jsonb(format('mesmo nome em famílias diferentes (%s): a busca por nome dirá "ambíguo"', v_row.households));
  end loop;

  for v_row in
    select g.full_name, h.label
      from public.guests g join public.households h on h.id = g.household_id
     where not exists (select 1 from pg_temp.import_rows r where r.household = h.label and r.name_search = g.name_search)
  loop
    v_warnings := v_warnings || to_jsonb(format('no banco mas fora da planilha (não foi apagado): %s — %s', v_row.full_name, v_row.label));
  end loop;

  if jsonb_array_length(v_errors) > 0 or not p_apply then
    return jsonb_build_object(
      'ok', jsonb_array_length(v_errors) = 0,
      'applied', false,
      'rows', (select count(*) from pg_temp.import_rows),
      'households', (select count(distinct household) from pg_temp.import_rows),
      'errors', v_errors,
      'warnings', v_warnings);
  end if;

  for v_row in select * from pg_temp.import_rows order by line loop
    insert into public.households (label) values (v_row.household)
    on conflict (label) do update set label = excluded.label
    returning id into v_household_id;

    update public.guests
       set full_name = v_row.full_name,
           phone_e164 = v_row.phone,
           relationship = v_row.relationship,
           is_minor = v_row.is_minor,
           can_answer_for_household = v_row.can_answer
     where household_id = v_household_id and name_search = v_row.name_search;
    if found then
      v_updated := v_updated + 1;
    else
      insert into public.guests (household_id, full_name, phone_e164, relationship, is_minor, can_answer_for_household)
      values (v_household_id, v_row.full_name, v_row.phone, v_row.relationship, v_row.is_minor, v_row.can_answer);
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'applied', true,
    'rows', v_inserted + v_updated,
    'households', (select count(distinct household) from pg_temp.import_rows),
    'inserted', v_inserted,
    'updated', v_updated,
    'errors', v_errors,
    'warnings', v_warnings);
end;
$function$;

CREATE OR REPLACE FUNCTION public.bot_actor(p_phone text)
 RETURNS TABLE(guest_id uuid, household_id uuid, can_answer_for_household boolean, verified_by text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select a.guest_id, a.household_id, a.can_answer_for_household, a.verified_by
    from (
      select g.id as guest_id, g.household_id, g.can_answer_for_household, 'phone'::text as verified_by, 1 as priority
        from public.guests g
       where g.phone_e164 = any (public.phone_variants(p_phone))
      union all
      select g.id, g.household_id, false, 'name', 2
        from public.wa_contacts c
        join public.guests g on g.id = c.linked_guest_id
       where c.phone = public.phone_digits(p_phone)
    ) as a
   order by a.priority
   limit 1
$function$;

CREATE OR REPLACE FUNCTION public.bot_add_note(p_phone text, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_phone text := public.phone_digits(p_phone);
  v_note text := btrim(regexp_replace(coalesce(p_note, ''), '\s+', ' ', 'g'));
begin
  if char_length(v_note) = 0 or char_length(v_note) > 200 then
    return jsonb_build_object('ok', false, 'error', 'invalid_note');
  end if;
  if (select count(*) from public.contact_notes n where n.phone = v_phone) >= 20 then
    return jsonb_build_object('ok', false, 'error', 'too_many_notes');
  end if;
  insert into public.contact_notes (phone, note) values (v_phone, v_note) on conflict do nothing;
  return jsonb_build_object('ok', true);
end;
$function$;

CREATE OR REPLACE FUNCTION public.bot_append_messages(p_session_id uuid, p_messages jsonb, p_new_turn boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if jsonb_typeof(p_messages) <> 'array' then
    raise exception 'invalid_messages' using errcode = '22023';
  end if;
  if not exists (select 1 from public.wa_sessions s where s.id = p_session_id and s.closed_at is null) then
    raise exception 'session_closed' using errcode = 'P0001';
  end if;

  insert into public.wa_session_messages (session_id, role, content)
  select p_session_id, m ->> 'role', m -> 'content'
    from jsonb_array_elements(p_messages) as m;

  update public.wa_sessions
     set last_message_at = now(),
         turns = turns + case when p_new_turn then 1 else 0 end,
         followed_up = case when p_new_turn then false else followed_up end
   where id = p_session_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.bot_apply_gift_event(p_event_id text, p_event text, p_checkout_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_new text;
  v_order record;
begin
  v_new := case p_event
    when 'CHECKOUT_PAID' then 'paid'
    when 'CHECKOUT_CANCELED' then 'canceled'
    when 'CHECKOUT_EXPIRED' then 'expired'
    when 'PAYMENT_REFUNDED' then 'refunded'
    when 'PAYMENT_CHARGEBACK_REQUESTED' then 'refunded'
    else null
  end;
  if v_new is null then
    return jsonb_build_object('ok', true, 'ignored', true);
  end if;
  if nullif(btrim(p_event_id), '') is null or nullif(btrim(p_checkout_id), '') is null then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  insert into public.gift_webhook_events (event_id, event) values (p_event_id, p_event)
  on conflict (event_id) do nothing;
  if not found then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;

  select o.id, o.status into v_order
    from public.gift_orders o
   where o.asaas_checkout_id = p_checkout_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if v_order.status = v_new
     or (v_new = 'paid' and v_order.status = 'refunded')
     or (v_new in ('canceled', 'expired') and v_order.status in ('paid', 'refunded'))
     or (v_new = 'refunded' and v_order.status <> 'paid') then
    return jsonb_build_object('ok', true, 'changed', false, 'status', v_order.status);
  end if;

  update public.gift_orders o
     set status = v_new,
         paid_at = case when v_new = 'paid' then now() else o.paid_at end,
         updated_at = now()
   where o.id = v_order.id;

  return jsonb_build_object('ok', true, 'changed', true, 'status', v_new, 'previous', v_order.status);
end;
$function$;

CREATE OR REPLACE FUNCTION public.bot_attach_gift_checkout(p_order_id uuid, p_checkout_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  update public.gift_orders o
     set asaas_checkout_id = p_checkout_id, updated_at = now()
   where o.id = p_order_id
     and o.status = 'pending'
     and o.asaas_checkout_id is null;
  return jsonb_build_object('ok', found);
end;
$function$;

CREATE OR REPLACE FUNCTION public.bot_claim_contact(p_phone text, p_lease_seconds integer DEFAULT 120)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  update public.wa_contacts
     set lease_until = now() + make_interval(secs => greatest(p_lease_seconds, 1))
   where phone = public.phone_digits(p_phone)
     and (lease_until is null or lease_until < now());
  return found;
end;
$function$;

CREATE OR REPLACE FUNCTION public.bot_close_session(p_session_id uuid, p_summary text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  update public.wa_sessions
     set closed_at = now(), summary = left(nullif(btrim(p_summary), ''), 2000)
   where id = p_session_id and closed_at is null
$function$;

CREATE OR REPLACE FUNCTION public.bot_consume_turn(p_phone text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_phone text := public.phone_digits(p_phone);
  v_today date := public.bot_today();
  v_settings public.rsvp_settings%rowtype;
  v_contact public.wa_contacts%rowtype;
  v_global integer;
begin
  select * into v_settings from public.rsvp_settings s where s.id = 1;
  select * into v_contact from public.wa_contacts c where c.phone = v_phone for update;
  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'unknown_contact');
  end if;

  if v_contact.turns_day = v_today and v_contact.turns_count >= v_settings.turns_per_phone_per_day then
    return jsonb_build_object('allowed', false, 'reason', 'phone_limit');
  end if;

  insert into public.bot_usage (day, turns) values (v_today, 0) on conflict (day) do nothing;
  select u.turns into v_global from public.bot_usage u where u.day = v_today for update;
  if v_global >= v_settings.turns_per_day then
    return jsonb_build_object('allowed', false, 'reason', 'global_limit');
  end if;

  update public.bot_usage set turns = turns + 1 where day = v_today;
  update public.wa_contacts
     set turns_count = case when turns_day = v_today then turns_count + 1 else 1 end,
         turns_day = v_today
   where phone = v_phone;
  return jsonb_build_object('allowed', true);
end;
$function$;

CREATE OR REPLACE FUNCTION public.bot_contact_card(p_phone text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'phone', public.phone_digits(p_phone),
    'display_name', (select c.display_name from public.wa_contacts c where c.phone = public.phone_digits(p_phone)),
    'guest_name', g.full_name,
    'household', h.label,
    'verified_by', a.verified_by)
    from (select 1) as one
    left join public.bot_actor(p_phone) as a on true
    left join public.guests g on g.id = a.guest_id
    left join public.households h on h.id = a.household_id
$function$;

CREATE OR REPLACE FUNCTION public.bot_create_gift_order(p_gift_id text, p_gift_name text, p_kind text, p_payment_method text, p_base_cents integer, p_charged_cents integer, p_message text, p_signature text, p_anonymous boolean, p_ip_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_message text := nullif(btrim(p_message), '');
  v_signature text := nullif(btrim(p_signature), '');
  v_anonymous boolean := coalesce(p_anonymous, false);
  v_id uuid;
begin
  -- Limpeza: pedidos não pagos somem em 48 h (com a mensagem); o hash do IP, em 24 h.
  delete from public.gift_orders o
   where o.status in ('pending', 'canceled', 'expired')
     and o.created_at < now() - interval '48 hours';
  update public.gift_orders o
     set ip_hash = null
   where o.ip_hash is not null
     and o.created_at < now() - interval '24 hours';
  delete from public.gift_webhook_events e
   where e.received_at < now() - interval '90 days';

  -- Limites: 5 pedidos por IP em 10 minutos e 300 por dia no total.
  if p_ip_hash is not null and (
       select count(*) from public.gift_orders o
        where o.ip_hash = p_ip_hash and o.created_at > now() - interval '10 minutes') >= 5 then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;
  if (select count(*) from public.gift_orders o where o.created_at > now() - interval '24 hours') >= 300 then
    return jsonb_build_object('ok', false, 'error', 'busy');
  end if;

  -- Pedido novo sempre diz a forma de pagamento.
  if p_payment_method is null or p_payment_method not in ('pix', 'card') then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  if v_message is null then
    v_signature := null;
    v_anonymous := false;
  elsif v_anonymous then
    v_signature := null;
  elsif v_signature is null then
    return jsonb_build_object('ok', false, 'error', 'signature_required');
  end if;

  insert into public.gift_orders (gift_id, gift_name, kind, payment_method, base_cents, charged_cents, message, signature, anonymous, ip_hash)
  values (p_gift_id, btrim(p_gift_name), p_kind, p_payment_method, p_base_cents, p_charged_cents, v_message, v_signature, v_anonymous, p_ip_hash)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id);
exception
  when check_violation or not_null_violation then
    return jsonb_build_object('ok', false, 'error', 'invalid');
end;
$function$;

CREATE OR REPLACE FUNCTION public.bot_cron_call(p_job text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_url text;
  v_secret text;
  v_request bigint;
begin
  if p_job not in ('tick', 'daily-report') then
    raise exception 'invalid_job' using errcode = '22023';
  end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_url using 'sofia_functions_url';
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_secret using 'sofia_cron_secret';
  if v_url is null or v_secret is null then
    raise warning 'Sof.IA: grave sofia_functions_url e sofia_cron_secret no Vault (job %).', p_job;
    return null;
  end if;

  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 10000)'
     into v_request
    using rtrim(v_url, '/') || '/whatsapp-cron',
          jsonb_build_object('job', p_job),
          jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret);
  return v_request;
end;
$function$;

CREATE OR REPLACE FUNCTION public.bot_cron_secret_ok(p_secret text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_secret text;
begin
  if p_secret is null or char_length(p_secret) < 32
     or not exists (select 1 from pg_namespace where nspname = 'vault') then
    return false;
  end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_secret using 'sofia_cron_secret';
  return v_secret is not null and v_secret = p_secret;
end;
$function$;

CREATE OR REPLACE FUNCTION public.bot_discard_gift_order(p_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  delete from public.gift_orders o
   where o.id = p_order_id
     and o.status = 'pending'
     and o.asaas_checkout_id is null;
  return jsonb_build_object('ok', found);
end;
$function$;

CREATE OR REPLACE FUNCTION public.bot_ensure_special_contact(p_phone text, p_role text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_digits text := public.phone_digits(p_phone);
  v_phone text;
  v_guest public.guests%rowtype;
  v_household_id uuid;
begin
  if p_role is null or p_role not in ('host', 'staff') then
    return jsonb_build_object('ok', false, 'error', 'invalid_role');
  end if;
  v_phone := coalesce(
    public.normalize_phone('+' || v_digits),
    case when v_digits ~ '^[1-9]\d{7,14}$' then '+' || v_digits end);
  if v_phone is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_phone');
  end if;

  select * into v_guest from public.guests g where g.phone_e164 = any (public.phone_variants(v_digits)) for update;
  if found then
    if v_guest.role <> p_role then
      update public.guests set role = p_role where id = v_guest.id;
    end if;
    return jsonb_build_object('ok', true, 'guest_id', v_guest.id, 'created', false, 'changed', v_guest.role <> p_role);
  end if;

  insert into public.households (label)
  values (case p_role when 'host' then 'Família da Sofia (organizadores)' else 'Equipe da festa' end)
  on conflict (label) do update set label = excluded.label
  returning id into v_household_id;

  -- O nome de verdade a Aifos pergunta na conversa (nome preferido e assinatura do recado).
  insert into public.guests (household_id, full_name, phone_e164, can_answer_for_household, role)
  values (v_household_id,
          case p_role when 'host' then 'Pai ou mãe da Sofia' else 'Equipe da festa' end,
          v_phone, false, p_role)
  returning * into v_guest;

  return jsonb_build_object('ok', true, 'guest_id', v_guest.id, 'created', true, 'changed', true);
end;
$function$;

CREATE OR REPLACE FUNCTION public.bot_find_guest_by_name(p_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_query text := public.normalize_name(p_name);
  v_words text[] := regexp_split_to_array(public.normalize_name(p_name), ' ');
  v_first text := split_part(public.normalize_name(p_name), ' ', 1);
  v_best record;
  v_exact integer;
  v_subset record;
begin
  if char_length(v_query) > 120
     or (select count(*) from regexp_split_to_table(v_query, ' ') w where char_length(w) >= 2) < 2 then
    return jsonb_build_object('status', 'need_full_name');
  end if;

  select count(*) into v_exact from public.guests g where g.role = 'guest' and g.name_search = v_query;
  if v_exact > 1 then
    return jsonb_build_object('status', 'ambiguous');
  end if;

  -- Nome curto de um nome longo: os outros nomes digitados estão todos no nome da lista.
  if v_exact = 0 then
    with words as (
      select g.id, g.full_name, g.phone_e164 is not null as has_phone,
             (regexp_split_to_array(g.name_search, ' '))[1] as first,
             (regexp_split_to_array(g.name_search, ' '))[2:] as rest
        from public.guests g
       where g.role = 'guest'
    ),
    subset as (
      select w.*, w.first = v_first as same_first
        from words w
       where v_words[2:] <@ w.rest
         and extensions.levenshtein(v_first, w.first)
             <= case when greatest(char_length(v_first), char_length(w.first)) >= 6 then 2 else 1 end
    ),
    tier as (
      select * from subset s
       where s.same_first or not exists (select 1 from subset x where x.same_first)
    )
    select count(*) as total, min(t.id::text)::uuid as id, min(t.full_name) as full_name, bool_or(t.has_phone) as has_phone
      into v_subset
      from tier t;

    if v_subset.total > 1 then
      return jsonb_build_object('status', 'ambiguous');
    end if;
    if v_subset.total = 1 then
      return jsonb_build_object(
        'status', 'found',
        'guest', jsonb_build_object('id', v_subset.id, 'full_name', v_subset.full_name, 'has_phone', v_subset.has_phone));
    end if;
  end if;

  -- Só disputa quem tem o primeiro nome parecido; o primeiro colocado traz a nota do segundo.
  with candidates as (
    select g.id, g.full_name, g.phone_e164 is not null as has_phone,
           case when g.name_search = v_query then 1.0
                else (extensions.similarity(v_query, g.name_search)
                      + extensions.word_similarity(v_query, g.name_search)) / 2 end as score
      from public.guests g
     where g.role = 'guest'
       and (g.name_search = v_query
            or extensions.levenshtein(v_first, split_part(g.name_search, ' ', 1))
               <= case when greatest(char_length(v_first), char_length(split_part(g.name_search, ' ', 1))) >= 6
                       then 2 else 1 end)
  ),
  ranked as (
    select c.*, row_number() over (order by c.score desc, c.full_name) as position from candidates c
  )
  select r.id, r.full_name, r.has_phone, r.score,
         (select max(o.score) from ranked o where o.position > 1) as second_score
    into v_best
    from ranked r
   where r.position = 1;

  if v_best.id is null or v_best.score < 0.55 then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_best.score < 1.0 and v_best.second_score is not null and v_best.score - v_best.second_score < 0.1 then
    return jsonb_build_object('status', 'ambiguous');
  end if;

  return jsonb_build_object(
    'status', 'found',
    'guest', jsonb_build_object('id', v_best.id, 'full_name', v_best.full_name, 'has_phone', v_best.has_phone));
end;
$function$;

CREATE OR REPLACE FUNCTION public.bot_followup_candidates(p_min_idle_minutes integer, p_max_idle_minutes integer, p_limit integer DEFAULT 20)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(x.phone order by x.last_message_at), '[]'::jsonb)
    from (
      select s.phone, s.last_message_at
        from public.wa_sessions s
        join public.wa_contacts c on c.phone = s.phone
       where s.closed_at is null
         and not s.followed_up
         and s.turns > 0
         and s.last_message_at <= now() - make_interval(mins => greatest(p_min_idle_minutes, 1))
         and s.last_message_at >= now() - make_interval(mins => greatest(p_max_idle_minutes, 1))
         and (c.lease_until is null or c.lease_until < now())
         and not exists (select 1 from public.wa_inbox i where i.phone = s.phone and i.processed_at is null)
         and (select m.role from public.wa_session_messages m
               where m.session_id = s.id order by m.id desc limit 1) = 'assistant'
       order by s.last_message_at
       limit least(greatest(p_limit, 0), 100)
    ) as x
$function$;

CREATE OR REPLACE FUNCTION public.bot_gift_messages()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
           'gift_name', o.gift_name,
           'signature', o.signature,
           'anonymous', o.anonymous,
           'body', o.message,
           'paid_at', o.paid_at)
         order by o.paid_at, o.id), '[]'::jsonb)
    from public.gift_orders o
   where o.status = 'paid'
     and o.message is not null
$function$;

CREATE OR REPLACE FUNCTION public.bot_gift_progress()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('gift_id', p.gift_id, 'raised_cents', p.raised) order by p.gift_id), '[]'::jsonb)
    from (
      select o.gift_id, sum(o.base_cents)::bigint as raised
        from public.gift_orders o
       where o.kind = 'fund' and o.status = 'paid'
       group by o.gift_id
    ) p
$function$;

CREATE OR REPLACE FUNCTION public.bot_gift_report()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
           'gift_name', o.gift_name,
           'kind', o.kind,
           'status', o.status,
           'payment_method', o.payment_method,
           'base_cents', o.base_cents,
           'payer_name', o.payer_name,
           'signature', o.signature,
           'anonymous', o.anonymous,
           'has_message', o.message is not null,
           'paid_at', o.paid_at)
         order by o.paid_at, o.id), '[]'::jsonb)
    from public.gift_orders o
   where o.status in ('paid', 'refunded')
$function$;

CREATE OR REPLACE FUNCTION public.bot_guest_messages()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id,
           'full_name', g.full_name,
           'household', h.label,
           'signature', m.signature,
           'body', m.body,
           'source', m.source,
           'approved', m.approved_at is not null,
           'sent_by', case when m.written_by is distinct from m.guest_id then w.full_name end,
           'created_at', m.created_at,
           'updated_at', m.updated_at)
         order by m.created_at, m.id), '[]'::jsonb)
    from public.guest_messages m
    join public.guests g on g.id = m.guest_id
    join public.households h on h.id = g.household_id
    left join public.guests w on w.id = m.written_by
   where not m.hidden
$function$;

CREATE OR REPLACE FUNCTION public.bot_household_status(p_phone text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor record;
  v_role text;
  v_settings public.rsvp_settings%rowtype;
begin
  select * into v_settings from public.rsvp_settings s where s.id = 1;
  select * into v_actor from public.bot_actor(p_phone);

  if v_actor.guest_id is null then
    return jsonb_build_object(
      'identified', false,
      'rsvp_open', public.rsvp_is_open(),
      'deadline', v_settings.deadline);
  end if;
  select g.role into v_role from public.guests g where g.id = v_actor.guest_id;

  return jsonb_build_object(
    'identified', true,
    'role', v_role,
    'verified_by', v_actor.verified_by,
    'rsvp_open', public.rsvp_is_open(),
    'deadline', v_settings.deadline,
    'actor_id', v_actor.guest_id,
    'household', case when v_actor.verified_by = 'phone'
                      then (select h.label from public.households h where h.id = v_actor.household_id) end,
    'members', (
      select jsonb_agg(jsonb_build_object(
               'id', g.id,
               'full_name', g.full_name,
               'relationship', g.relationship,
               'is_minor', g.is_minor,
               'is_you', g.id = v_actor.guest_id,
               'rsvp_status', g.rsvp_status,
               'can_answer', g.id = v_actor.guest_id or (v_actor.can_answer_for_household and g.role = 'guest'),
               'message', (
                 select case
                          when g.id = v_actor.guest_id or m.written_by = v_actor.guest_id then
                            jsonb_build_object(
                              'can_change', true,
                              'written_by_you', m.written_by = v_actor.guest_id,
                              'written_by_owner', m.written_by = g.id,
                              'body', m.body,
                              'signature', m.signature,
                              'updated_at', m.updated_at)
                          else
                            jsonb_build_object(
                              'can_change', false,
                              'written_by_you', false,
                              'written_by_owner', m.written_by is not distinct from g.id)
                        end
                   from public.guest_messages m
                  where m.guest_id = g.id))
             order by (g.id = v_actor.guest_id) desc, g.is_minor, g.full_name)
        from public.guests g
       where g.household_id = v_actor.household_id
         and (v_actor.verified_by = 'phone' or g.id = v_actor.guest_id)
         and (v_role = 'guest' or g.id = v_actor.guest_id)));
end;
$function$;

CREATE OR REPLACE FUNCTION public.bot_identity_request_status(p_phone text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'id', r.id,
    'status', r.status,
    'claimed_name', r.claimed_name,
    'created_at', r.created_at,
    'resolved_at', r.resolved_at)
    from public.identity_requests r
   where r.phone = public.phone_digits(p_phone)
   order by r.created_at desc, r.id desc
   limit 1
$function$;

CREATE OR REPLACE FUNCTION public.bot_inbox_add(p_wa_message_id text, p_phone text, p_push_name text, p_kind text, p_body text DEFAULT NULL::text, p_audio_seconds integer DEFAULT NULL::integer, p_remote_jid text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_phone text := public.phone_digits(p_phone);
  v_id bigint;
begin
  insert into public.wa_contacts (phone, display_name)
  values (v_phone, left(nullif(btrim(p_push_name), ''), 80))
  on conflict (phone) do update
    set display_name = coalesce(excluded.display_name, public.wa_contacts.display_name),
        last_seen_at = now();

  insert into public.wa_inbox (wa_message_id, phone, kind, body, audio_seconds, remote_jid)
  values (p_wa_message_id, v_phone, p_kind, left(p_body, 4000), p_audio_seconds, left(p_remote_jid, 128))
  on conflict (wa_message_id) do nothing
  returning id into v_id;

  return jsonb_build_object('inserted', v_id is not null, 'id', v_id);
end;
$function$;

CREATE OR REPLACE FUNCTION public.bot_inbox_done(p_ids bigint[])
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  update public.wa_inbox set processed_at = now() where id = any (p_ids) and processed_at is null
$function$;

CREATE OR REPLACE FUNCTION public.bot_inbox_pending(p_phone text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', i.id,
           'wa_message_id', i.wa_message_id,
           'remote_jid', i.remote_jid,
           'kind', i.kind,
           'body', i.body,
           'audio_seconds', i.audio_seconds,
           'received_at', i.received_at)
         order by i.id), '[]'::jsonb)
    from public.wa_inbox i
   where i.phone = public.phone_digits(p_phone) and i.processed_at is null
$function$;

CREATE OR REPLACE FUNCTION public.bot_inbox_stalled(p_min_age_seconds integer, p_limit integer DEFAULT 20)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(x.phone order by x.oldest), '[]'::jsonb)
    from (
      select i.phone, min(i.received_at) as oldest
        from public.wa_inbox i
        join public.wa_contacts c on c.phone = i.phone
       where i.processed_at is null
         and (c.lease_until is null or c.lease_until < now())
       group by i.phone
      having min(i.received_at) <= now() - make_interval(secs => greatest(p_min_age_seconds, 0))
       order by min(i.received_at)
       limit least(greatest(p_limit, 0), 100)
    ) as x
$function$;

CREATE OR REPLACE FUNCTION public.bot_link_contact(p_phone text, p_guest_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_phone text := public.phone_digits(p_phone);
  v_actor record;
  v_guest public.guests%rowtype;
begin
  select * into v_actor from public.bot_actor(v_phone);
  if v_actor.verified_by = 'phone' then
    return jsonb_build_object('ok', false, 'error', 'already_identified');
  end if;

  select * into v_guest from public.guests g where g.id = p_guest_id and g.role = 'guest' for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_guest.phone_e164 is not null then
    return jsonb_build_object('ok', false, 'error', 'has_other_phone');
  end if;
  if exists (select 1 from public.wa_contacts c where c.linked_guest_id = p_guest_id and c.phone <> v_phone) then
    return jsonb_build_object('ok', false, 'error', 'linked_to_other_contact');
  end if;

  insert into public.wa_contacts (phone, linked_guest_id)
  values (v_phone, p_guest_id)
  on conflict (phone) do update set linked_guest_id = excluded.linked_guest_id;

  return jsonb_build_object('ok', true, 'guest_id', p_guest_id, 'full_name', v_guest.full_name);
end;
$function$;

CREATE OR REPLACE FUNCTION public.bot_load_memory(p_phone text, p_summaries integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'contact', (
      select jsonb_build_object(
               'display_name', c.display_name,
               'preferred_name', c.preferred_name,
               'first_seen_at', c.first_seen_at,
               'is_first_conversation', not exists (
                 select 1 from public.wa_sessions s where s.phone = c.phone and s.turns > 0))
        from public.wa_contacts c where c.phone = public.phone_digits(p_phone)),
    'session', (
      select jsonb_build_object(
               'id', s.id,
               'started_at', s.started_at,
               'last_message_at', s.last_message_at,
               'turns', s.turns,
               'messages', coalesce((
                 select jsonb_agg(jsonb_build_object('role', m.role, 'content', m.content) order by m.id)
                   from public.wa_session_messages m where m.session_id = s.id), '[]'::jsonb))
        from public.wa_sessions s
       where s.phone = public.phone_digits(p_phone) and s.closed_at is null),
    'summaries', coalesce((
      select jsonb_agg(jsonb_build_object('started_at', x.started_at, 'summary', x.summary) order by x.started_at)
        from (select s.started_at, s.summary
                from public.wa_sessions s
               where s.phone = public.phone_digits(p_phone) and s.closed_at is not null and s.summary is not null
               order by s.started_at desc
               limit greatest(p_summaries, 0)) as x), '[]'::jsonb),
    'notes', coalesce((
      select jsonb_agg(n.note order by n.id)
        from public.contact_notes n where n.phone = public.phone_digits(p_phone)), '[]'::jsonb))
$function$;

CREATE OR REPLACE FUNCTION public.bot_mark_followed_up(p_session_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  update public.wa_sessions set followed_up = true where id = p_session_id
$function$;

CREATE OR REPLACE FUNCTION public.bot_open_session(p_phone text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_phone text := public.phone_digits(p_phone);
  v_id uuid;
begin
  select s.id into v_id from public.wa_sessions s where s.phone = v_phone and s.closed_at is null;
  if v_id is null then
    insert into public.wa_sessions (phone) values (v_phone) returning id into v_id;
  end if;
  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.bot_purge_conversations()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_contacts integer;
begin
  delete from public.wa_contacts;  -- cascata: inbox, sessões, mensagens e notas
  get diagnostics v_contacts = row_count;
  delete from public.bot_usage;
  update public.rsvp_events set origin_phone = null where origin_phone is not null;
  return jsonb_build_object('contacts_deleted', v_contacts);
end;
$function$;

CREATE OR REPLACE FUNCTION public.bot_release_contact(p_phone text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  update public.wa_contacts set lease_until = null where phone = public.phone_digits(p_phone)
$function$;

CREATE OR REPLACE FUNCTION public.bot_report()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'generated_at', now(),
    'rsvp_open', public.rsvp_is_open(),
    'deadline', (select s.deadline from public.rsvp_settings s where s.id = 1),
    'totals', (
      select jsonb_build_object(
        'guests', count(*),
        'attending', count(*) filter (where g.rsvp_status = 'attending'),
        'declined', count(*) filter (where g.rsvp_status = 'declined'),
        'pending', count(*) filter (where g.rsvp_status = 'pending'),
        'attending_minors', count(*) filter (where g.rsvp_status = 'attending' and g.is_minor))
        from public.guests g
       where g.role = 'guest'),
    'messages', (
      select jsonb_build_object(
        'total', count(*),
        'last_24h', count(*) filter (where m.updated_at >= now() - interval '24 hours'),
        'awaiting_approval', count(*) filter (where m.approved_at is null))
        from public.guest_messages m
       where not m.hidden),
    'households', coalesce((
      select jsonb_agg(jsonb_build_object(
               'label', h.label,
               'members', (
                 select jsonb_agg(jsonb_build_object(
                          'full_name', g.full_name,
                          'is_minor', g.is_minor,
                          'rsvp_status', g.rsvp_status,
                          'rsvp_updated_at', g.rsvp_updated_at)
                        order by g.is_minor, g.full_name)
                   from public.guests g where g.household_id = h.id and g.role = 'guest'))
             order by h.label)
        from public.households h
       where exists (select 1 from public.guests g where g.household_id = h.id and g.role = 'guest')), '[]'::jsonb))
$function$;

CREATE OR REPLACE FUNCTION public.bot_request_identity(p_phone text, p_claimed_name text, p_guest_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_phone text := public.phone_digits(p_phone);
  v_name text := btrim(regexp_replace(coalesce(p_claimed_name, ''), '\s+', ' ', 'g'));
  v_actor record;
  v_existing public.identity_requests%rowtype;
  v_guest_name text;
  v_guest_phone text;
  v_household text;
  v_id bigint;
begin
  if not exists (select 1 from public.wa_contacts c where c.phone = v_phone) then
    return jsonb_build_object('ok', false, 'error', 'unknown_contact');
  end if;
  select * into v_actor from public.bot_actor(v_phone);
  if v_actor.guest_id is not null then
    return jsonb_build_object('ok', false, 'error', 'already_identified');
  end if;
  if char_length(v_name) < 2 or char_length(v_name) > 120 then
    return jsonb_build_object('ok', false, 'error', 'invalid_name');
  end if;

  select * into v_existing from public.identity_requests r where r.phone = v_phone and r.status = 'pending';
  if found then
    return jsonb_build_object('ok', true, 'created', false, 'id', v_existing.id);
  end if;
  if exists (select 1 from public.identity_requests r where r.phone = v_phone and r.status = 'rejected') then
    return jsonb_build_object('ok', false, 'error', 'rejected');
  end if;
  if (select count(*) from public.identity_requests r where r.phone = v_phone) >= 3 then
    return jsonb_build_object('ok', false, 'error', 'too_many_requests');
  end if;

  if p_guest_id is not null then
    select g.full_name, g.phone_e164, h.label
      into v_guest_name, v_guest_phone, v_household
      from public.guests g join public.households h on h.id = g.household_id
     where g.id = p_guest_id;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'not_found');
    end if;
  end if;

  insert into public.identity_requests (phone, claimed_name, guest_id)
  values (v_phone, v_name, p_guest_id)
  returning id into v_id;

  return jsonb_build_object(
    'ok', true,
    'created', true,
    'id', v_id,
    'phone', v_phone,
    'claimed_name', v_name,
    'display_name', (select c.display_name from public.wa_contacts c where c.phone = v_phone),
    'guest_name', v_guest_name,
    'household', v_household,
    'guest_phone', v_guest_phone);
end;
$function$;

CREATE OR REPLACE FUNCTION public.bot_resolve_identity_request(p_id bigint, p_accept boolean, p_admin_phone text, p_guest_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_req public.identity_requests%rowtype;
  v_guest_id uuid;
  v_found jsonb;
  v_guest public.guests%rowtype;
  v_household text;
  v_new_phone text;
  v_conflict text;
  v_name text := nullif(btrim(regexp_replace(coalesce(p_guest_name, ''), '\s+', ' ', 'g')), '');
begin
  select * into v_req from public.identity_requests r where r.id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_req.status <> 'pending' then
    return jsonb_build_object(
      'ok', false,
      'error', 'already_resolved',
      'status', v_req.status,
      'guest_name', (select g.full_name from public.guests g where g.id = v_req.resolved_guest_id));
  end if;

  if not p_accept then
    update public.identity_requests
       set status = 'rejected', resolved_at = now(), resolved_by = public.phone_digits(p_admin_phone)
     where id = v_req.id;
    return jsonb_build_object('ok', true, 'status', 'rejected', 'phone', v_req.phone, 'claimed_name', v_req.claimed_name);
  end if;

  v_guest_id := v_req.guest_id;
  if v_name is not null then
    v_found := public.bot_find_guest_by_name(v_name);
    if v_found ->> 'status' <> 'found' then
      return jsonb_build_object('ok', false, 'error', 'guest_' || (v_found ->> 'status'));
    end if;
    v_guest_id := (v_found -> 'guest' ->> 'id')::uuid;
  end if;
  if v_guest_id is null then
    return jsonb_build_object('ok', false, 'error', 'need_guest_name', 'claimed_name', v_req.claimed_name);
  end if;

  select * into v_guest from public.guests g where g.id = v_guest_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'guest_not_found');
  end if;
  select h.label into v_household from public.households h where h.id = v_guest.household_id;

  v_new_phone := coalesce(
    public.normalize_phone('+' || v_req.phone),
    case when v_req.phone ~ '^[1-9]\d{7,14}$' then '+' || v_req.phone end);
  select g.full_name into v_conflict
    from public.guests g
   where g.id <> v_guest.id and g.phone_e164 = any (public.phone_variants(v_req.phone))
   limit 1;
  if v_conflict is not null then
    return jsonb_build_object('ok', false, 'error', 'phone_in_use', 'other_name', v_conflict);
  end if;

  update public.guests set phone_e164 = v_new_phone where id = v_guest.id;
  -- Um número por pessoa: vínculos por nome de outros contatos com ela deixam de valer.
  update public.wa_contacts set linked_guest_id = null where linked_guest_id = v_guest.id;
  update public.identity_requests
     set status = 'accepted',
         resolved_guest_id = v_guest.id,
         previous_phone = v_guest.phone_e164,
         resolved_at = now(),
         resolved_by = public.phone_digits(p_admin_phone)
   where id = v_req.id;

  return jsonb_build_object(
    'ok', true,
    'status', 'accepted',
    'phone', v_req.phone,
    'claimed_name', v_req.claimed_name,
    'guest_name', v_guest.full_name,
    'household', v_household,
    'previous_phone', v_guest.phone_e164);
end;
$function$;

CREATE OR REPLACE FUNCTION public.bot_save_guest_message(p_phone text, p_body text, p_signature text DEFAULT NULL::text, p_source text DEFAULT 'text'::text, p_wa_message_id text DEFAULT NULL::text, p_for_guest_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor record;
  v_actor_role text;
  v_target uuid;
  v_target_name text;
  v_target_role text;
  v_existing record;
  v_body text := btrim(regexp_replace(coalesce(p_body, ''), '[ \t]+', ' ', 'g'));
  v_signature text := nullif(btrim(regexp_replace(coalesce(p_signature, ''), '\s+', ' ', 'g')), '');
begin
  select * into v_actor from public.bot_actor(p_phone);
  if v_actor.guest_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_identified');
  end if;
  if char_length(v_body) = 0 or char_length(v_body) > 1000 then
    return jsonb_build_object('ok', false, 'error', 'invalid_message');
  end if;
  if v_signature is not null and char_length(v_signature) > 80 then
    return jsonb_build_object('ok', false, 'error', 'invalid_signature');
  end if;
  if coalesce(p_source, '') not in ('text', 'audio') then
    return jsonb_build_object('ok', false, 'error', 'invalid_source');
  end if;

  v_target := coalesce(p_for_guest_id, v_actor.guest_id);
  select g.full_name, g.role into v_target_name, v_target_role
    from public.guests g
   where g.id = v_target
     and g.household_id = v_actor.household_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_in_household');
  end if;
  select g.role into v_actor_role from public.guests g where g.id = v_actor.guest_id;
  -- Pelos outros, só quem confirmou pelo telefone e responde pela família, e só por convidados.
  if v_target <> v_actor.guest_id
     and not (v_actor.verified_by = 'phone' and v_actor.can_answer_for_household
              and v_actor_role = 'guest' and v_target_role = 'guest') then
    return jsonb_build_object('ok', false, 'error', 'not_allowed');
  end if;

  select m.id, m.written_by into v_existing
    from public.guest_messages m
   where m.guest_id = v_target
     for update;
  if found and v_target <> v_actor.guest_id and v_existing.written_by is distinct from v_actor.guest_id then
    return jsonb_build_object('ok', false, 'error', 'message_owned', 'full_name', v_target_name);
  end if;

  insert into public.guest_messages (guest_id, written_by, body, signature, source, wa_message_id)
  values (v_target, v_actor.guest_id, v_body, v_signature, p_source, p_wa_message_id)
  on conflict (guest_id) do update
     set written_by = excluded.written_by,
         body = excluded.body,
         signature = excluded.signature,
         source = excluded.source,
         wa_message_id = excluded.wa_message_id,
         hidden = false;

  return jsonb_build_object('ok', true, 'replaced', v_existing.id is not null, 'full_name', v_target_name);
end;
$function$;

CREATE OR REPLACE FUNCTION public.bot_set_gift_payer(p_checkout_id text, p_payer_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_name text := nullif(btrim(regexp_replace(coalesce(p_payer_name, ''), '\s+', ' ', 'g')), '');
begin
  if v_name is null or nullif(btrim(p_checkout_id), '') is null then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  update public.gift_orders o
     set payer_name = left(v_name, 120), updated_at = now()
   where o.asaas_checkout_id = p_checkout_id
     and o.payer_name is null;
  return jsonb_build_object('ok', true, 'changed', found);
end;
$function$;

CREATE OR REPLACE FUNCTION public.bot_set_message_approval(p_id bigint, p_approved boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_msg record;
begin
  select m.id, m.hidden, m.approved_at, coalesce(m.signature, g.full_name) as sender
    into v_msg
    from public.guest_messages m
    join public.guests g on g.id = m.guest_id
   where m.id = p_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_msg.hidden then
    return jsonb_build_object('ok', false, 'error', 'hidden');
  end if;

  update public.guest_messages m
     set approved_at = case when p_approved then coalesce(m.approved_at, now()) end
   where m.id = p_id;

  return jsonb_build_object('ok', true, 'approved', p_approved, 'from', v_msg.sender);
end;
$function$;

CREATE OR REPLACE FUNCTION public.bot_set_preferred_name(p_phone text, p_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_name text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
begin
  if char_length(v_name) = 0 or char_length(v_name) > 60 then
    return jsonb_build_object('ok', false, 'error', 'invalid_name');
  end if;
  update public.wa_contacts set preferred_name = v_name where phone = public.phone_digits(p_phone);
  return jsonb_build_object('ok', found);
end;
$function$;

CREATE OR REPLACE FUNCTION public.bot_set_rsvp(p_phone text, p_targets uuid[], p_status text, p_wa_message_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor record;
  v_targets uuid[];
  v_target uuid;
  v_guest public.guests%rowtype;
  v_results jsonb := '[]'::jsonb;
begin
  if p_status is null or p_status not in ('attending', 'declined') then
    return jsonb_build_object('ok', false, 'error', 'invalid_status');
  end if;

  select * into v_actor from public.bot_actor(p_phone);
  if v_actor.guest_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_identified');
  end if;
  if (select g.role from public.guests g where g.id = v_actor.guest_id) <> 'guest' then
    return jsonb_build_object('ok', false, 'error', 'not_a_guest');
  end if;

  if not public.rsvp_is_open() then
    return jsonb_build_object('ok', false, 'error', 'rsvp_closed');
  end if;

  select coalesce(array_agg(distinct t), '{}') into v_targets from unnest(p_targets) t where t is not null;
  if cardinality(v_targets) = 0 then
    return jsonb_build_object('ok', false, 'error', 'no_targets');
  end if;
  if cardinality(v_targets) > 30 then
    return jsonb_build_object('ok', false, 'error', 'too_many_targets');
  end if;

  -- Valida todos antes de gravar qualquer um (e trava as linhas).
  foreach v_target in array v_targets loop
    select * into v_guest from public.guests g where g.id = v_target for update;
    if not found or v_guest.household_id <> v_actor.household_id then
      return jsonb_build_object('ok', false, 'error', 'not_in_household', 'guest_id', v_target);
    end if;
    if v_guest.role <> 'guest' then
      return jsonb_build_object('ok', false, 'error', 'not_a_guest', 'guest_id', v_target);
    end if;
    if v_guest.id <> v_actor.guest_id and not v_actor.can_answer_for_household then
      return jsonb_build_object('ok', false, 'error', 'not_allowed', 'guest_id', v_target);
    end if;
  end loop;

  foreach v_target in array v_targets loop
    select * into v_guest from public.guests g where g.id = v_target;
    if v_guest.rsvp_status <> p_status then
      update public.guests
         set rsvp_status = p_status,
             rsvp_updated_at = now(),
             rsvp_updated_by = v_actor.guest_id,
             rsvp_channel = 'whatsapp'
       where id = v_target;
      insert into public.rsvp_events
        (guest_id, previous_status, new_status, actor_guest_id, origin_phone, wa_message_id, channel)
      values
        (v_target, v_guest.rsvp_status, p_status, v_actor.guest_id, public.phone_digits(p_phone), p_wa_message_id, 'whatsapp');
    end if;
    v_results := v_results || jsonb_build_object(
      'guest_id', v_target,
      'full_name', v_guest.full_name,
      'previous_status', v_guest.rsvp_status,
      'rsvp_status', p_status,
      'changed', v_guest.rsvp_status <> p_status);
  end loop;

  return jsonb_build_object('ok', true, 'results', v_results);
end;
$function$;

CREATE OR REPLACE FUNCTION public.bot_site_messages()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with wall as (
    select s.unseal_at, now() < s.unseal_at as sealed
      from public.message_wall_settings s
     where s.id = 1
  ), letters as (
    select m.public_id, m.approved_at, m.id,
           coalesce(m.signature, split_part(g.full_name, ' ', 1)) as sender,
           m.body
      from public.guest_messages m
      join public.guests g on g.id = m.guest_id
     where m.approved_at is not null
       and not m.hidden
     order by m.approved_at, m.id
     limit 300
  )
  select jsonb_build_object(
    'sealed', w.sealed,
    'unseal_at', w.unseal_at,
    'letters', coalesce((
      select jsonb_agg(
               case when w.sealed
                    then jsonb_build_object('id', l.public_id, 'from', l.sender)
                    else jsonb_build_object('id', l.public_id, 'from', l.sender, 'body', l.body)
               end
             order by l.approved_at, l.id)
        from letters l), '[]'::jsonb))
    from wall w
$function$;

CREATE OR REPLACE FUNCTION public.bot_suggest_guest_names(p_name text, p_limit integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with q as (select public.normalize_name(left(coalesce(p_name, ''), 120)) as v),
  scored as (
    select g.full_name, h.label as household,
           (extensions.similarity(q.v, g.name_search) + extensions.word_similarity(q.v, g.name_search)) / 2 as score
      from public.guests g
      join public.households h on h.id = g.household_id
      cross join q
     where q.v <> ''
       and g.role = 'guest'
  )
  select coalesce(
    jsonb_agg(jsonb_build_object('full_name', s.full_name, 'household', s.household) order by s.score desc, s.full_name),
    '[]'::jsonb)
    from (
      select * from scored
       where score >= 0.3
       order by score desc, full_name
       limit greatest(1, least(coalesce(p_limit, 3), 5))
    ) s;
$function$;

CREATE OR REPLACE FUNCTION public.bot_today()
 RETURNS date
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select (now() at time zone 'America/Sao_Paulo')::date
$function$;

CREATE OR REPLACE FUNCTION public.forbid_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  raise exception 'append_only' using errcode = 'P0001';
end;
$function$;

CREATE OR REPLACE FUNCTION public.guest_messages_reset_approval()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if new.body is distinct from old.body or new.signature is distinct from old.signature then
    new.approved_at := null;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.normalize_name(p_name text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO ''
AS $function$
  select btrim(regexp_replace(
    translate(lower(coalesce(p_name, '')),
              'áàâãäåéèêëíìîïóòôõöúùûüçñý',
              'aaaaaaeeeeiiiiooooouuuucny'),
    '[^a-z0-9]+', ' ', 'g'))
$function$;

CREATE OR REPLACE FUNCTION public.normalize_phone(p_phone text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO ''
AS $function$
declare
  v_digits text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_international boolean := btrim(coalesce(p_phone, '')) like '+%';
begin
  if v_digits = '' then
    return null;
  end if;

  if v_international and v_digits !~ '^55' then
    return case when v_digits ~ '^[1-9]\d{7,14}$' then '+' || v_digits end;
  end if;

  v_digits := ltrim(v_digits, '0');               -- "031 ..." (prefixo de longa distância)
  if length(v_digits) in (10, 11) then
    v_digits := '55' || v_digits;                 -- DDD + número, sem o país
  end if;
  if v_digits !~ '^55[1-9][1-9]' then
    return null;
  end if;
  if v_digits ~ '^55\d{2}[6-9]\d{7}$' then
    v_digits := left(v_digits, 4) || '9' || right(v_digits, 8);  -- celular antigo, sem o 9
  end if;
  return case when v_digits ~ '^55\d{2}(9\d{8}|[2-5]\d{7})$' then '+' || v_digits end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.phone_digits(p_phone text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO ''
AS $function$
  select regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')
$function$;

CREATE OR REPLACE FUNCTION public.phone_variants(p_phone text)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO ''
AS $function$
  select case
    when d ~ '^55\d{2}9\d{8}$'    then array['+' || d, '+' || left(d, 4) || right(d, 8)]
    when d ~ '^55\d{2}[6-9]\d{7}$' then array['+' || d, '+' || left(d, 4) || '9' || right(d, 8)]
    when d ~ '^[1-9]\d{7,14}$'     then array['+' || d]
    else array[]::text[]
  end
  from (select regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as d) as x
$function$;

CREATE OR REPLACE FUNCTION public.rsvp_is_open()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select coalesce(
    (select s.accepting_responses and (s.deadline is null or now() <= s.deadline)
       from public.rsvp_settings s where s.id = 1),
    false)
$function$;

CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  new.updated_at := now();
  return new;
end;
$function$;

-- ============================================================================
-- Tabelas
-- ============================================================================

create table public.bot_usage (
  day date not null,
  turns integer default 0 not null,
  constraint bot_usage_pkey PRIMARY KEY (day)
);

create table public.contact_notes (
  id bigint generated always as identity,
  phone text not null,
  note text not null,
  created_at timestamp with time zone default now() not null,
  constraint contact_notes_pkey PRIMARY KEY (id),
  constraint contact_notes_unique UNIQUE (phone, note),
  constraint contact_notes_note_check CHECK (((char_length(note) >= 1) AND (char_length(note) <= 200)))
);

-- Presentes da lista (checkout do Asaas). Só os pagos contam na vaquinha e vão para o Livro de Recados.
create table public.gift_orders (
  id uuid default gen_random_uuid() not null,
  gift_id text not null,
  gift_name text not null,
  kind text not null,
  base_cents integer not null,
  charged_cents integer not null,
  message text,
  signature text,
  anonymous boolean default false not null,
  status text default 'pending'::text not null,
  asaas_checkout_id text,
  ip_hash text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  paid_at timestamp with time zone,
  payment_method text,
  payer_name text,
  constraint gift_orders_pkey PRIMARY KEY (id),
  constraint gift_orders_asaas_checkout_id_key UNIQUE (asaas_checkout_id),
  constraint gift_orders_asaas_checkout_id_check CHECK (((asaas_checkout_id IS NULL) OR ((char_length(asaas_checkout_id) >= 1) AND (char_length(asaas_checkout_id) <= 100)))),
  constraint gift_orders_base_cents_check CHECK (((base_cents >= 1) AND (base_cents <= 10000000))),
  constraint gift_orders_check CHECK (((charged_cents >= base_cents) AND (charged_cents <= 11000000))),
  constraint gift_orders_gift_id_check CHECK ((gift_id ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$'::text)),
  constraint gift_orders_gift_name_check CHECK (((char_length(gift_name) >= 1) AND (char_length(gift_name) <= 80))),
  constraint gift_orders_ip_hash_check CHECK (((ip_hash IS NULL) OR (ip_hash ~ '^[0-9a-f]{64}$'::text))),
  constraint gift_orders_kind_check CHECK ((kind = ANY (ARRAY['quota'::text, 'fund'::text]))),
  constraint gift_orders_message_check CHECK (((message IS NULL) OR ((char_length(message) >= 1) AND (char_length(message) <= 500)))),
  constraint gift_orders_payer_name_check CHECK (((payer_name IS NULL) OR ((char_length(payer_name) >= 1) AND (char_length(payer_name) <= 120)))),
  constraint gift_orders_payment_method_check CHECK (((payment_method IS NULL) OR (payment_method = ANY (ARRAY['pix'::text, 'card'::text])))),
  constraint gift_orders_secret_has_no_signature CHECK ((NOT (anonymous AND (signature IS NOT NULL)))),
  constraint gift_orders_signature_check CHECK (((signature IS NULL) OR ((char_length(signature) >= 1) AND (char_length(signature) <= 60)))),
  constraint gift_orders_signature_needs_message CHECK (((message IS NOT NULL) OR ((signature IS NULL) AND (NOT anonymous)))),
  constraint gift_orders_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'paid'::text, 'canceled'::text, 'expired'::text, 'refunded'::text])))
);
comment on column public.gift_orders.payment_method is 'Botão escolhido no site: pix ou card (null = pedido de antes da escolha no site).';
comment on column public.gift_orders.payer_name is 'Nome de quem pagou (cliente no Asaas). Só para os organizadores, pelo comando "presentes".';

create table public.gift_webhook_events (
  event_id text not null,
  event text not null,
  received_at timestamp with time zone default now() not null,
  constraint gift_webhook_events_pkey PRIMARY KEY (event_id),
  constraint gift_webhook_events_event_id_check CHECK (((char_length(event_id) >= 1) AND (char_length(event_id) <= 120)))
);

-- Recados dos convidados para a Sofia, recolhidos pela Professora Aifos. Um por convidado.
create table public.guest_messages (
  id bigint generated always as identity,
  guest_id uuid not null,
  body text not null,
  signature text,
  source text default 'text'::text not null,
  wa_message_id text,
  hidden boolean default false not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  public_id uuid default gen_random_uuid() not null,
  approved_at timestamp with time zone,
  written_by uuid,
  constraint guest_messages_pkey PRIMARY KEY (id),
  constraint guest_messages_guest_id_key UNIQUE (guest_id),
  constraint guest_messages_body_check CHECK (((char_length(body) >= 1) AND (char_length(body) <= 1000))),
  constraint guest_messages_signature_check CHECK (((signature IS NULL) OR ((char_length(signature) >= 1) AND (char_length(signature) <= 80)))),
  constraint guest_messages_source_check CHECK ((source = ANY (ARRAY['text'::text, 'audio'::text])))
);
comment on column public.guest_messages.hidden is 'Ocultado pelos organizadores: some do comando "recados" e do Livro de Recados.';
comment on column public.guest_messages.public_id is 'Identificador opaco enviado ao site (o id sequencial não sai do banco).';
comment on column public.guest_messages.approved_at is 'Aprovado pelos organizadores para o Salão Principal do site; nulo = aguardando.';
comment on column public.guest_messages.written_by is 'Quem gravou o recado pela Aifos (o dono ou um responsável pela família). Nulo: quem escreveu saiu da lista; só o dono troca.';

create table public.guests (
  id uuid default gen_random_uuid() not null,
  household_id uuid not null,
  full_name text not null,
  name_search text generated always as (normalize_name(full_name)) stored,
  phone_e164 text,
  relationship text,
  is_minor boolean default false not null,
  can_answer_for_household boolean default true not null,
  rsvp_status text default 'pending'::text not null,
  rsvp_updated_at timestamp with time zone,
  rsvp_updated_by uuid,
  rsvp_channel text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  role text default 'guest'::text not null,
  constraint guests_pkey PRIMARY KEY (id),
  constraint guests_name_unique_in_household UNIQUE (household_id, name_search),
  constraint guests_phone_e164_key UNIQUE (phone_e164),
  constraint guests_full_name_check CHECK (((char_length(btrim(full_name)) >= 2) AND (char_length(btrim(full_name)) <= 120))),
  constraint guests_minor_cannot_answer_for_household CHECK ((NOT (is_minor AND can_answer_for_household))),
  constraint guests_phone_e164_check CHECK (((phone_e164 IS NULL) OR (phone_e164 ~ '^\+[1-9]\d{7,14}$'::text))),
  constraint guests_relationship_check CHECK (((relationship IS NULL) OR (char_length(relationship) <= 40))),
  constraint guests_role_check CHECK ((role = ANY (ARRAY['guest'::text, 'host'::text, 'staff'::text]))),
  constraint guests_rsvp_channel_check CHECK (((rsvp_channel IS NULL) OR (rsvp_channel = ANY (ARRAY['whatsapp'::text, 'admin'::text])))),
  constraint guests_rsvp_status_check CHECK ((rsvp_status = ANY (ARRAY['pending'::text, 'attending'::text, 'declined'::text])))
);
comment on column public.guests.phone_e164 is 'Opcional (menores costumam não ter). Um telefone identifica um único convidado.';
comment on column public.guests.can_answer_for_household is 'Pode confirmar pelos outros membros da família. Nunca verdadeiro para menores.';
comment on column public.guests.role is 'guest = convidado; host = pai ou mãe da Sofia (ADMIN_PHONES); staff = equipe da festa (STAFF_PHONES). Só guest confirma presença e entra nas contagens.';

-- Famílias convidadas. O rótulo é a chave da importação da planilha.
create table public.households (
  id uuid default gen_random_uuid() not null,
  label text not null,
  notes text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint households_pkey PRIMARY KEY (id),
  constraint households_label_key UNIQUE (label),
  constraint households_label_check CHECK (((char_length(btrim(label)) >= 2) AND (char_length(btrim(label)) <= 80))),
  constraint households_notes_check CHECK (((notes IS NULL) OR (char_length(notes) <= 500)))
);

-- Pedidos de identidade decididos pelos organizadores ("aceitar N" / "recusar N" no WhatsApp).
create table public.identity_requests (
  id bigint generated always as identity,
  phone text not null,
  claimed_name text not null,
  guest_id uuid,
  status text default 'pending'::text not null,
  resolved_guest_id uuid,
  previous_phone text,
  resolved_by text,
  created_at timestamp with time zone default now() not null,
  resolved_at timestamp with time zone,
  constraint identity_requests_pkey PRIMARY KEY (id),
  constraint identity_requests_claimed_name_check CHECK (((char_length(claimed_name) >= 2) AND (char_length(claimed_name) <= 120))),
  constraint identity_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text])))
);

create table public.message_wall_settings (
  id smallint default 1 not null,
  unseal_at timestamp with time zone not null,
  constraint message_wall_settings_pkey PRIMARY KEY (id),
  constraint message_wall_settings_id_check CHECK ((id = 1))
);

create table public.rsvp_events (
  id bigint generated always as identity,
  guest_id uuid not null,
  previous_status text not null,
  new_status text not null,
  actor_guest_id uuid,
  origin_phone text,
  wa_message_id text,
  channel text not null,
  created_at timestamp with time zone default now() not null,
  constraint rsvp_events_pkey PRIMARY KEY (id),
  constraint rsvp_events_channel_check CHECK ((channel = ANY (ARRAY['whatsapp'::text, 'admin'::text])))
);

-- Política da confirmação (linha única): aceitar respostas, prazo e tetos de uso do agente.
create table public.rsvp_settings (
  id smallint default 1 not null,
  accepting_responses boolean default true not null,
  deadline timestamp with time zone,
  updated_at timestamp with time zone default now() not null,
  turns_per_phone_per_day integer default 40 not null,
  turns_per_day integer default 800 not null,
  constraint rsvp_settings_pkey PRIMARY KEY (id),
  constraint rsvp_settings_id_check CHECK ((id = 1)),
  constraint rsvp_settings_turns_per_day_check CHECK ((turns_per_day > 0)),
  constraint rsvp_settings_turns_per_phone_per_day_check CHECK ((turns_per_phone_per_day > 0))
);

create table public.wa_contacts (
  phone text not null,
  display_name text,
  preferred_name text,
  linked_guest_id uuid,
  first_seen_at timestamp with time zone default now() not null,
  last_seen_at timestamp with time zone default now() not null,
  lease_until timestamp with time zone,
  turns_day date,
  turns_count integer default 0 not null,
  constraint wa_contacts_pkey PRIMARY KEY (phone),
  constraint wa_contacts_linked_guest_id_key UNIQUE (linked_guest_id),
  constraint wa_contacts_display_name_check CHECK (((display_name IS NULL) OR (char_length(display_name) <= 80))),
  constraint wa_contacts_phone_check CHECK ((phone ~ '^[1-9]\d{7,14}$'::text)),
  constraint wa_contacts_preferred_name_check CHECK (((preferred_name IS NULL) OR (char_length(preferred_name) <= 60)))
);
comment on column public.wa_contacts.phone is 'Número como o WhatsApp entrega: só dígitos, com o código do país.';
comment on column public.wa_contacts.lease_until is 'Trava: só um processamento por telefone de cada vez.';

create table public.wa_inbox (
  id bigint generated always as identity,
  wa_message_id text not null,
  phone text not null,
  kind text not null,
  body text,
  audio_seconds integer,
  received_at timestamp with time zone default now() not null,
  processed_at timestamp with time zone,
  remote_jid text,
  constraint wa_inbox_pkey PRIMARY KEY (id),
  constraint wa_inbox_wa_message_id_key UNIQUE (wa_message_id),
  constraint wa_inbox_audio_seconds_check CHECK (((audio_seconds IS NULL) OR (audio_seconds >= 0))),
  constraint wa_inbox_body_check CHECK (((body IS NULL) OR (char_length(body) <= 4000))),
  constraint wa_inbox_kind_check CHECK ((kind = ANY (ARRAY['text'::text, 'audio'::text, 'image'::text, 'video'::text, 'sticker'::text, 'other'::text]))),
  constraint wa_inbox_remote_jid_check CHECK (((remote_jid IS NULL) OR (char_length(remote_jid) <= 128))),
  constraint wa_inbox_wa_message_id_check CHECK (((char_length(wa_message_id) >= 1) AND (char_length(wa_message_id) <= 128)))
);
comment on column public.wa_inbox.remote_jid is 'Conversa no WhatsApp (…@s.whatsapp.net ou …@lid), para reagir e marcar como lida.';

create table public.wa_session_messages (
  id bigint generated always as identity,
  session_id uuid not null,
  role text not null,
  content jsonb not null,
  created_at timestamp with time zone default now() not null,
  constraint wa_session_messages_pkey PRIMARY KEY (id),
  constraint wa_session_messages_content_check CHECK ((jsonb_typeof(content) = ANY (ARRAY['string'::text, 'array'::text]))),
  constraint wa_session_messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text, 'system'::text])))
);

create table public.wa_sessions (
  id uuid default gen_random_uuid() not null,
  phone text not null,
  started_at timestamp with time zone default now() not null,
  last_message_at timestamp with time zone default now() not null,
  turns integer default 0 not null,
  closed_at timestamp with time zone,
  summary text,
  followed_up boolean default false not null,
  constraint wa_sessions_pkey PRIMARY KEY (id),
  constraint wa_sessions_summary_check CHECK (((summary IS NULL) OR (char_length(summary) <= 2000)))
);
comment on column public.wa_sessions.followed_up is 'A Sof.IA já retomou esta conversa desde a última mensagem do convidado.';

alter table public.contact_notes add constraint contact_notes_phone_fkey FOREIGN KEY (phone) REFERENCES wa_contacts(phone) ON DELETE CASCADE;
alter table public.guest_messages add constraint guest_messages_guest_id_fkey FOREIGN KEY (guest_id) REFERENCES guests(id) ON DELETE CASCADE;
alter table public.guest_messages add constraint guest_messages_written_by_fkey FOREIGN KEY (written_by) REFERENCES guests(id) ON DELETE SET NULL;
alter table public.guests add constraint guests_household_id_fkey FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE;
alter table public.guests add constraint guests_rsvp_updated_by_fkey FOREIGN KEY (rsvp_updated_by) REFERENCES guests(id) ON DELETE SET NULL;
alter table public.identity_requests add constraint identity_requests_guest_id_fkey FOREIGN KEY (guest_id) REFERENCES guests(id) ON DELETE SET NULL;
alter table public.identity_requests add constraint identity_requests_phone_fkey FOREIGN KEY (phone) REFERENCES wa_contacts(phone) ON DELETE CASCADE;
alter table public.identity_requests add constraint identity_requests_resolved_guest_id_fkey FOREIGN KEY (resolved_guest_id) REFERENCES guests(id) ON DELETE SET NULL;
alter table public.rsvp_events add constraint rsvp_events_actor_guest_id_fkey FOREIGN KEY (actor_guest_id) REFERENCES guests(id) ON DELETE SET NULL;
alter table public.rsvp_events add constraint rsvp_events_guest_id_fkey FOREIGN KEY (guest_id) REFERENCES guests(id) ON DELETE CASCADE;
alter table public.wa_contacts add constraint wa_contacts_linked_guest_id_fkey FOREIGN KEY (linked_guest_id) REFERENCES guests(id) ON DELETE SET NULL;
alter table public.wa_inbox add constraint wa_inbox_phone_fkey FOREIGN KEY (phone) REFERENCES wa_contacts(phone) ON DELETE CASCADE;
alter table public.wa_session_messages add constraint wa_session_messages_session_id_fkey FOREIGN KEY (session_id) REFERENCES wa_sessions(id) ON DELETE CASCADE;
alter table public.wa_sessions add constraint wa_sessions_phone_fkey FOREIGN KEY (phone) REFERENCES wa_contacts(phone) ON DELETE CASCADE;

-- ============================================================================
-- Índices
-- ============================================================================

CREATE INDEX gift_orders_ip_recent ON public.gift_orders USING btree (ip_hash, created_at) WHERE (ip_hash IS NOT NULL);
CREATE INDEX gift_orders_status ON public.gift_orders USING btree (status, kind);
CREATE UNIQUE INDEX guest_messages_public_id_key ON public.guest_messages USING btree (public_id);
CREATE INDEX guests_household_idx ON public.guests USING btree (household_id);
CREATE UNIQUE INDEX identity_requests_one_pending_idx ON public.identity_requests USING btree (phone) WHERE (status = 'pending'::text);
CREATE INDEX identity_requests_phone_idx ON public.identity_requests USING btree (phone, created_at DESC);
CREATE INDEX identity_requests_resolved_guest_idx ON public.identity_requests USING btree (resolved_guest_id) WHERE (status = 'accepted'::text);
CREATE INDEX rsvp_events_guest_idx ON public.rsvp_events USING btree (guest_id, created_at DESC);
CREATE INDEX wa_inbox_pending_idx ON public.wa_inbox USING btree (phone, id) WHERE (processed_at IS NULL);
CREATE INDEX wa_session_messages_session_idx ON public.wa_session_messages USING btree (session_id, id);
CREATE UNIQUE INDEX wa_sessions_one_open_idx ON public.wa_sessions USING btree (phone) WHERE (closed_at IS NULL);
CREATE INDEX wa_sessions_phone_idx ON public.wa_sessions USING btree (phone, started_at DESC);

-- ============================================================================
-- Gatilhos
-- ============================================================================

CREATE TRIGGER guest_messages_reset_approval BEFORE UPDATE ON public.guest_messages FOR EACH ROW EXECUTE FUNCTION guest_messages_reset_approval();
CREATE TRIGGER guest_messages_set_updated_at BEFORE UPDATE ON public.guest_messages FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER guests_set_updated_at BEFORE UPDATE ON public.guests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER households_set_updated_at BEFORE UPDATE ON public.households FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER rsvp_settings_set_updated_at BEFORE UPDATE ON public.rsvp_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER wa_session_messages_append_only BEFORE UPDATE ON public.wa_session_messages FOR EACH ROW EXECUTE FUNCTION forbid_update();

-- ============================================================================
-- Segurança: RLS e permissões
-- ============================================================================

-- RLS ligado em todas as tabelas, sem políticas: anon/authenticated não leem nem escrevem nada.
alter table public.bot_usage enable row level security;
alter table public.contact_notes enable row level security;
alter table public.gift_orders enable row level security;
alter table public.gift_webhook_events enable row level security;
alter table public.guest_messages enable row level security;
alter table public.guests enable row level security;
alter table public.households enable row level security;
alter table public.identity_requests enable row level security;
alter table public.message_wall_settings enable row level security;
alter table public.rsvp_events enable row level security;
alter table public.rsvp_settings enable row level security;
alter table public.wa_contacts enable row level security;
alter table public.wa_inbox enable row level security;
alter table public.wa_session_messages enable row level security;
alter table public.wa_sessions enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on function public.admin_import_guests(p_rows jsonb, p_apply boolean) from public, anon, authenticated;
grant execute on function public.admin_import_guests(p_rows jsonb, p_apply boolean) to service_role;
revoke all on function public.bot_actor(p_phone text) from public, anon, authenticated;
grant execute on function public.bot_actor(p_phone text) to service_role;
revoke all on function public.bot_add_note(p_phone text, p_note text) from public, anon, authenticated;
grant execute on function public.bot_add_note(p_phone text, p_note text) to service_role;
revoke all on function public.bot_append_messages(p_session_id uuid, p_messages jsonb, p_new_turn boolean) from public, anon, authenticated;
grant execute on function public.bot_append_messages(p_session_id uuid, p_messages jsonb, p_new_turn boolean) to service_role;
revoke all on function public.bot_apply_gift_event(p_event_id text, p_event text, p_checkout_id text) from public, anon, authenticated;
grant execute on function public.bot_apply_gift_event(p_event_id text, p_event text, p_checkout_id text) to service_role;
revoke all on function public.bot_attach_gift_checkout(p_order_id uuid, p_checkout_id text) from public, anon, authenticated;
grant execute on function public.bot_attach_gift_checkout(p_order_id uuid, p_checkout_id text) to service_role;
revoke all on function public.bot_claim_contact(p_phone text, p_lease_seconds integer) from public, anon, authenticated;
grant execute on function public.bot_claim_contact(p_phone text, p_lease_seconds integer) to service_role;
revoke all on function public.bot_close_session(p_session_id uuid, p_summary text) from public, anon, authenticated;
grant execute on function public.bot_close_session(p_session_id uuid, p_summary text) to service_role;
revoke all on function public.bot_consume_turn(p_phone text) from public, anon, authenticated;
grant execute on function public.bot_consume_turn(p_phone text) to service_role;
revoke all on function public.bot_contact_card(p_phone text) from public, anon, authenticated;
grant execute on function public.bot_contact_card(p_phone text) to service_role;
revoke all on function public.bot_create_gift_order(p_gift_id text, p_gift_name text, p_kind text, p_payment_method text, p_base_cents integer, p_charged_cents integer, p_message text, p_signature text, p_anonymous boolean, p_ip_hash text) from public, anon, authenticated;
grant execute on function public.bot_create_gift_order(p_gift_id text, p_gift_name text, p_kind text, p_payment_method text, p_base_cents integer, p_charged_cents integer, p_message text, p_signature text, p_anonymous boolean, p_ip_hash text) to service_role;
revoke all on function public.bot_cron_call(p_job text) from public, anon, authenticated;
revoke all on function public.bot_cron_secret_ok(p_secret text) from public, anon, authenticated;
grant execute on function public.bot_cron_secret_ok(p_secret text) to service_role;
revoke all on function public.bot_discard_gift_order(p_order_id uuid) from public, anon, authenticated;
grant execute on function public.bot_discard_gift_order(p_order_id uuid) to service_role;
revoke all on function public.bot_ensure_special_contact(p_phone text, p_role text) from public, anon, authenticated;
grant execute on function public.bot_ensure_special_contact(p_phone text, p_role text) to service_role;
revoke all on function public.bot_find_guest_by_name(p_name text) from public, anon, authenticated;
grant execute on function public.bot_find_guest_by_name(p_name text) to service_role;
revoke all on function public.bot_followup_candidates(p_min_idle_minutes integer, p_max_idle_minutes integer, p_limit integer) from public, anon, authenticated;
grant execute on function public.bot_followup_candidates(p_min_idle_minutes integer, p_max_idle_minutes integer, p_limit integer) to service_role;
revoke all on function public.bot_gift_messages() from public, anon, authenticated;
grant execute on function public.bot_gift_messages() to service_role;
revoke all on function public.bot_gift_progress() from public, anon, authenticated;
grant execute on function public.bot_gift_progress() to service_role;
revoke all on function public.bot_gift_report() from public, anon, authenticated;
grant execute on function public.bot_gift_report() to service_role;
revoke all on function public.bot_guest_messages() from public, anon, authenticated;
grant execute on function public.bot_guest_messages() to service_role;
revoke all on function public.bot_household_status(p_phone text) from public, anon, authenticated;
grant execute on function public.bot_household_status(p_phone text) to service_role;
revoke all on function public.bot_identity_request_status(p_phone text) from public, anon, authenticated;
grant execute on function public.bot_identity_request_status(p_phone text) to service_role;
revoke all on function public.bot_inbox_add(p_wa_message_id text, p_phone text, p_push_name text, p_kind text, p_body text, p_audio_seconds integer, p_remote_jid text) from public, anon, authenticated;
grant execute on function public.bot_inbox_add(p_wa_message_id text, p_phone text, p_push_name text, p_kind text, p_body text, p_audio_seconds integer, p_remote_jid text) to service_role;
revoke all on function public.bot_inbox_done(p_ids bigint[]) from public, anon, authenticated;
grant execute on function public.bot_inbox_done(p_ids bigint[]) to service_role;
revoke all on function public.bot_inbox_pending(p_phone text) from public, anon, authenticated;
grant execute on function public.bot_inbox_pending(p_phone text) to service_role;
revoke all on function public.bot_inbox_stalled(p_min_age_seconds integer, p_limit integer) from public, anon, authenticated;
grant execute on function public.bot_inbox_stalled(p_min_age_seconds integer, p_limit integer) to service_role;
revoke all on function public.bot_link_contact(p_phone text, p_guest_id uuid) from public, anon, authenticated;
grant execute on function public.bot_link_contact(p_phone text, p_guest_id uuid) to service_role;
revoke all on function public.bot_load_memory(p_phone text, p_summaries integer) from public, anon, authenticated;
grant execute on function public.bot_load_memory(p_phone text, p_summaries integer) to service_role;
revoke all on function public.bot_mark_followed_up(p_session_id uuid) from public, anon, authenticated;
grant execute on function public.bot_mark_followed_up(p_session_id uuid) to service_role;
revoke all on function public.bot_open_session(p_phone text) from public, anon, authenticated;
grant execute on function public.bot_open_session(p_phone text) to service_role;
revoke all on function public.bot_purge_conversations() from public, anon, authenticated;
grant execute on function public.bot_purge_conversations() to service_role;
revoke all on function public.bot_release_contact(p_phone text) from public, anon, authenticated;
grant execute on function public.bot_release_contact(p_phone text) to service_role;
revoke all on function public.bot_report() from public, anon, authenticated;
grant execute on function public.bot_report() to service_role;
revoke all on function public.bot_request_identity(p_phone text, p_claimed_name text, p_guest_id uuid) from public, anon, authenticated;
grant execute on function public.bot_request_identity(p_phone text, p_claimed_name text, p_guest_id uuid) to service_role;
revoke all on function public.bot_resolve_identity_request(p_id bigint, p_accept boolean, p_admin_phone text, p_guest_name text) from public, anon, authenticated;
grant execute on function public.bot_resolve_identity_request(p_id bigint, p_accept boolean, p_admin_phone text, p_guest_name text) to service_role;
revoke all on function public.bot_save_guest_message(p_phone text, p_body text, p_signature text, p_source text, p_wa_message_id text, p_for_guest_id uuid) from public, anon, authenticated;
grant execute on function public.bot_save_guest_message(p_phone text, p_body text, p_signature text, p_source text, p_wa_message_id text, p_for_guest_id uuid) to service_role;
revoke all on function public.bot_set_gift_payer(p_checkout_id text, p_payer_name text) from public, anon, authenticated;
grant execute on function public.bot_set_gift_payer(p_checkout_id text, p_payer_name text) to service_role;
revoke all on function public.bot_set_message_approval(p_id bigint, p_approved boolean) from public, anon, authenticated;
grant execute on function public.bot_set_message_approval(p_id bigint, p_approved boolean) to service_role;
revoke all on function public.bot_set_preferred_name(p_phone text, p_name text) from public, anon, authenticated;
grant execute on function public.bot_set_preferred_name(p_phone text, p_name text) to service_role;
revoke all on function public.bot_set_rsvp(p_phone text, p_targets uuid[], p_status text, p_wa_message_id text) from public, anon, authenticated;
grant execute on function public.bot_set_rsvp(p_phone text, p_targets uuid[], p_status text, p_wa_message_id text) to service_role;
revoke all on function public.bot_site_messages() from public, anon, authenticated;
grant execute on function public.bot_site_messages() to service_role;
revoke all on function public.bot_suggest_guest_names(p_name text, p_limit integer) from public, anon, authenticated;
grant execute on function public.bot_suggest_guest_names(p_name text, p_limit integer) to service_role;
revoke all on function public.bot_today() from public, anon, authenticated;
grant execute on function public.bot_today() to service_role;
revoke all on function public.forbid_update() from public, anon, authenticated;
grant execute on function public.forbid_update() to service_role;
revoke all on function public.guest_messages_reset_approval() from public, anon, authenticated;
grant execute on function public.guest_messages_reset_approval() to service_role;
revoke all on function public.normalize_name(p_name text) from public, anon, authenticated;
grant execute on function public.normalize_name(p_name text) to service_role;
revoke all on function public.normalize_phone(p_phone text) from public, anon, authenticated;
grant execute on function public.normalize_phone(p_phone text) to service_role;
revoke all on function public.phone_digits(p_phone text) from public, anon, authenticated;
grant execute on function public.phone_digits(p_phone text) to service_role;
revoke all on function public.phone_variants(p_phone text) from public, anon, authenticated;
grant execute on function public.phone_variants(p_phone text) to service_role;
revoke all on function public.rsvp_is_open() from public, anon, authenticated;
grant execute on function public.rsvp_is_open() to service_role;
revoke all on function public.set_updated_at() from public, anon, authenticated;
grant execute on function public.set_updated_at() to service_role;

-- ============================================================================
-- Agendamentos (pg_cron, só no Supabase)
-- ============================================================================

-- Horários em UTC: o relatório diário das 12h UTC chega às 9h de Brasília.
select cron.schedule('sofia-tick', '*/15 * * * *', $cmd$select public.bot_cron_call('tick')$cmd$);
select cron.schedule('sofia-relatorio-diario', '0 12 * * *', $cmd$select public.bot_cron_call('daily-report')$cmd$);
