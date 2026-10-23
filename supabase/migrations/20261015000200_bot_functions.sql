-- =============================================================================
--  Funções do bot (executáveis só pelo service_role das Edge Functions)
-- =============================================================================
--  Princípio: a IA conversa e propõe; o banco decide. A identidade nunca vem do
--  modelo: toda função recebe o TELEFONE do remetente (fornecido pelo código a
--  partir do webhook) e descobre aqui quem é a pessoa e o que ela pode fazer.
--
--  Identificação (public.bot_actor):
--   • 'phone': o telefone está na lista → pode responder por si e, se for adulto
--     com can_answer_for_household, pela família inteira;
--   • 'name':  telefone desconhecido, vinculado pela busca por nome a um convidado
--     SEM telefone na lista → responde só por si e não vê o resto da família.
--
--  Erros de regra voltam como {"ok": false, "error": "..."} para o agente explicar
--  à pessoa; nada é gravado nesses casos.
-- =============================================================================

-- Dia corrente no fuso da festa (tetos diários).
create or replace function public.bot_today()
returns date
language sql
stable
set search_path = ''
as $$
  select (now() at time zone 'America/Sao_Paulo')::date
$$;

create or replace function public.rsvp_is_open()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select s.accepting_responses and (s.deadline is null or now() <= s.deadline)
       from public.rsvp_settings s where s.id = 1),
    false)
$$;

-- Só dígitos, como em wa_contacts.phone.
create or replace function public.phone_digits(p_phone text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')
$$;

-- Quem é o remetente. O telefone da lista tem prioridade sobre o vínculo por nome.
create or replace function public.bot_actor(p_phone text)
returns table (guest_id uuid, household_id uuid, can_answer_for_household boolean, verified_by text)
language sql
stable
security definer
set search_path = ''
as $$
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
$$;

-- -----------------------------------------------------------------------------
-- Situação da família, do ponto de vista do remetente
-- -----------------------------------------------------------------------------
create or replace function public.bot_household_status(p_phone text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor record;
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

  return jsonb_build_object(
    'identified', true,
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
               'can_answer', g.id = v_actor.guest_id or v_actor.can_answer_for_household)
             order by (g.id = v_actor.guest_id) desc, g.is_minor, g.full_name)
        from public.guests g
       where g.household_id = v_actor.household_id
         and (v_actor.verified_by = 'phone' or g.id = v_actor.guest_id)));
end;
$$;

-- -----------------------------------------------------------------------------
-- Busca por nome (só quando o telefone não identificou)
--  Exige nome e sobrenome. Devolve no máximo UM candidato: nunca uma lista,
--  para que ninguém descubra quem são os convidados por tentativa.
-- -----------------------------------------------------------------------------
create or replace function public.bot_find_guest_by_name(p_name text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_query text := public.normalize_name(p_name);
  v_best record;
  v_second_score real;
  v_exact integer;
begin
  if char_length(v_query) > 120
     or (select count(*) from regexp_split_to_table(v_query, ' ') w where char_length(w) >= 2) < 2 then
    return jsonb_build_object('status', 'need_full_name');
  end if;

  select count(*) into v_exact from public.guests g where g.name_search = v_query;
  if v_exact > 1 then
    return jsonb_build_object('status', 'ambiguous');
  end if;

  select g.id, g.full_name, g.phone_e164 is not null as has_phone,
         case when g.name_search = v_query then 1.0
              else (extensions.similarity(v_query, g.name_search)
                    + extensions.word_similarity(v_query, g.name_search)) / 2 end as score
    into v_best
    from public.guests g
   order by score desc, g.full_name
   limit 1;

  if v_best.id is null or v_best.score < 0.55 then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_best.score < 1.0 then
    select max((extensions.similarity(v_query, g.name_search)
                + extensions.word_similarity(v_query, g.name_search)) / 2)
      into v_second_score
      from public.guests g
     where g.id <> v_best.id;
    if v_second_score is not null and v_best.score - v_second_score < 0.1 then
      return jsonb_build_object('status', 'ambiguous');
    end if;
  end if;

  return jsonb_build_object(
    'status', 'found',
    'guest', jsonb_build_object('id', v_best.id, 'full_name', v_best.full_name, 'has_phone', v_best.has_phone));
end;
$$;

-- Vincula um telefone desconhecido ao convidado encontrado pelo nome. Bloqueia
-- quem tem outro telefone na lista (ninguém responde por outra pessoa só
-- digitando o nome dela) e convidados já vinculados a outro contato.
create or replace function public.bot_link_contact(p_phone text, p_guest_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone text := public.phone_digits(p_phone);
  v_actor record;
  v_guest public.guests%rowtype;
begin
  select * into v_actor from public.bot_actor(v_phone);
  if v_actor.verified_by = 'phone' then
    return jsonb_build_object('ok', false, 'error', 'already_identified');
  end if;

  select * into v_guest from public.guests g where g.id = p_guest_id for update;
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
$$;

-- -----------------------------------------------------------------------------
-- Registrar resposta: tudo ou nada, com auditoria
-- -----------------------------------------------------------------------------
create or replace function public.bot_set_rsvp(
  p_phone text,
  p_targets uuid[],
  p_status text,
  p_wa_message_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- -----------------------------------------------------------------------------
-- Relatório do organizador (determinístico; o código formata o texto)
-- -----------------------------------------------------------------------------
create or replace function public.bot_report()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
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
        from public.guests g),
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
                   from public.guests g where g.household_id = h.id))
             order by h.label)
        from public.households h
       where exists (select 1 from public.guests g where g.household_id = h.id)), '[]'::jsonb))
$$;

-- -----------------------------------------------------------------------------
-- Entrada de mensagens, trava por telefone e tetos de uso
-- -----------------------------------------------------------------------------

-- Idempotente: a Evolution pode reenviar o mesmo evento.
create or replace function public.bot_inbox_add(
  p_wa_message_id text,
  p_phone text,
  p_push_name text,
  p_kind text,
  p_body text default null,
  p_audio_seconds integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone text := public.phone_digits(p_phone);
  v_id bigint;
begin
  insert into public.wa_contacts (phone, display_name)
  values (v_phone, left(nullif(btrim(p_push_name), ''), 80))
  on conflict (phone) do update
    set display_name = coalesce(excluded.display_name, public.wa_contacts.display_name),
        last_seen_at = now();

  insert into public.wa_inbox (wa_message_id, phone, kind, body, audio_seconds)
  values (p_wa_message_id, v_phone, p_kind, left(p_body, 4000), p_audio_seconds)
  on conflict (wa_message_id) do nothing
  returning id into v_id;

  return jsonb_build_object('inserted', v_id is not null, 'id', v_id);
end;
$$;

-- Trava de processamento: só um worker por telefone. Mensagens que chegam
-- durante o processamento ficam no inbox e são respondidas juntas na volta.
create or replace function public.bot_claim_contact(p_phone text, p_lease_seconds integer default 120)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.wa_contacts
     set lease_until = now() + make_interval(secs => greatest(p_lease_seconds, 1))
   where phone = public.phone_digits(p_phone)
     and (lease_until is null or lease_until < now());
  return found;
end;
$$;

create or replace function public.bot_release_contact(p_phone text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.wa_contacts set lease_until = null where phone = public.phone_digits(p_phone)
$$;

create or replace function public.bot_inbox_pending(p_phone text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', i.id,
           'wa_message_id', i.wa_message_id,
           'kind', i.kind,
           'body', i.body,
           'audio_seconds', i.audio_seconds,
           'received_at', i.received_at)
         order by i.id), '[]'::jsonb)
    from public.wa_inbox i
   where i.phone = public.phone_digits(p_phone) and i.processed_at is null
$$;

create or replace function public.bot_inbox_done(p_ids bigint[])
returns void
language sql
security definer
set search_path = ''
as $$
  update public.wa_inbox set processed_at = now() where id = any (p_ids) and processed_at is null
$$;

-- Consome um turno do agente, respeitando o teto por telefone e o global do dia.
create or replace function public.bot_consume_turn(p_phone text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- -----------------------------------------------------------------------------
-- Memória: sessão atual, resumos de sessões anteriores e notas
-- -----------------------------------------------------------------------------
create or replace function public.bot_load_memory(p_phone text, p_summaries integer default 3)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
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
$$;

-- Sessão aberta do contato (cria se não houver).
create or replace function public.bot_open_session(p_phone text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- Acrescenta mensagens ao histórico (nunca edita). p_new_turn conta um turno
-- do convidado (as mensagens de resultado de ferramenta não contam).
create or replace function public.bot_append_messages(p_session_id uuid, p_messages jsonb, p_new_turn boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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
         turns = turns + case when p_new_turn then 1 else 0 end
   where id = p_session_id;
end;
$$;

-- Encerra a sessão guardando o resumo gerado pelo agente.
create or replace function public.bot_close_session(p_session_id uuid, p_summary text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.wa_sessions
     set closed_at = now(), summary = left(nullif(btrim(p_summary), ''), 2000)
   where id = p_session_id and closed_at is null
$$;

-- Nota duradoura sobre o contato (máx. 20 por contato).
create or replace function public.bot_add_note(p_phone text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

create or replace function public.bot_set_preferred_name(p_phone text, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
begin
  if char_length(v_name) = 0 or char_length(v_name) > 60 then
    return jsonb_build_object('ok', false, 'error', 'invalid_name');
  end if;
  update public.wa_contacts set preferred_name = v_name where phone = public.phone_digits(p_phone);
  return jsonb_build_object('ok', found);
end;
$$;

-- LGPD: apaga conversas, memória e vínculos por nome (a lista e as respostas ficam).
create or replace function public.bot_purge_conversations()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contacts integer;
begin
  delete from public.wa_contacts;  -- cascata: inbox, sessões, mensagens e notas
  get diagnostics v_contacts = row_count;
  delete from public.bot_usage;
  update public.rsvp_events set origin_phone = null where origin_phone is not null;
  return jsonb_build_object('contacts_deleted', v_contacts);
end;
$$;

-- -----------------------------------------------------------------------------
-- Importação da planilha de convidados (scripts/import-guests.mjs)
--  p_rows: [{household, full_name, phone, relationship, is_minor, can_answer_for_household}]
--  Valida tudo; só grava com p_apply = true e sem erros. Reimportar atualiza
--  (família pelo rótulo, convidado pelo nome normalizado) e nunca mexe nas respostas.
-- -----------------------------------------------------------------------------
create or replace function public.admin_import_guests(p_rows jsonb, p_apply boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
           as can_answer
    from jsonb_array_elements(p_rows) with ordinality as r(v, ord);

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
$$;

-- -----------------------------------------------------------------------------
-- Privilégios: nada para o público; tudo só para o service_role.
-- (O Supabase concede EXECUTE a anon/authenticated por padrão em funções novas.)
-- -----------------------------------------------------------------------------
do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.bot_today()',
    'public.rsvp_is_open()',
    'public.phone_digits(text)',
    'public.bot_actor(text)',
    'public.bot_household_status(text)',
    'public.bot_find_guest_by_name(text)',
    'public.bot_link_contact(text, uuid)',
    'public.bot_set_rsvp(text, uuid[], text, text)',
    'public.bot_report()',
    'public.bot_inbox_add(text, text, text, text, text, integer)',
    'public.bot_claim_contact(text, integer)',
    'public.bot_release_contact(text)',
    'public.bot_inbox_pending(text)',
    'public.bot_inbox_done(bigint[])',
    'public.bot_consume_turn(text)',
    'public.bot_load_memory(text, integer)',
    'public.bot_open_session(text)',
    'public.bot_append_messages(uuid, jsonb, boolean)',
    'public.bot_close_session(uuid, text)',
    'public.bot_add_note(text, text)',
    'public.bot_set_preferred_name(text, text)',
    'public.bot_purge_conversations()',
    'public.admin_import_guests(jsonb, boolean)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end;
$$;
