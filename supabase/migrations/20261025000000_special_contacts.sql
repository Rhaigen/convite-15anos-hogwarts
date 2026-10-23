-- =============================================================================
--  Pais da Sofia e equipe da festa (cerimonial) na conversa com a Aifos
-- =============================================================================
--  Plano e decisões: docs/arquitetura.md#professora-aifos.
--
--  Os pais (os números de ADMIN_PHONES) e a equipe (STAFF_PHONES) não são
--  convidados: não confirmam presença e ficam fora das contagens. Podem tirar
--  dúvidas da festa e deixar o próprio recado para a Sofia, que precisa de uma
--  linha em guests (guest_messages.guest_id). Por isso ganham um papel:
--   • guests.role: 'guest' (padrão), 'host' (pais), 'staff' (equipe);
--   • bot_ensure_special_contact: chamada pelo código a cada conversa de um
--     desses números. Cria a linha (os telefones ficam só no banco e nos
--     secrets, nunca no repositório) ou muda o papel de quem já está na lista;
--   • a busca por nome, as sugestões e o vínculo por nome nunca chegam a essas
--     linhas: ninguém vira "mãe da Sofia" dizendo o nome. Só o telefone vale;
--   • o banco recusa resposta de presença de quem não é convidado ou para ele;
--   • recado: cada um só o próprio, e ninguém deixa recado na vaga deles.
-- =============================================================================

alter table public.guests
  add column if not exists role text not null default 'guest' check (role in ('guest', 'host', 'staff'));

comment on column public.guests.role is
  'guest = convidado; host = pai ou mãe da Sofia (ADMIN_PHONES); staff = equipe da festa (STAFF_PHONES). Só guest confirma presença e entra nas contagens.';

-- -----------------------------------------------------------------------------
-- Pais e equipe: garante a linha do número com o papel certo (idempotente)
-- -----------------------------------------------------------------------------
create or replace function public.bot_ensure_special_contact(p_phone text, p_role text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- -----------------------------------------------------------------------------
-- Situação de quem escreve: inclui o papel; pais e equipe só veem a si mesmos
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
$$;

-- -----------------------------------------------------------------------------
-- Resposta de presença: só de convidado e para convidado
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
$$;

-- -----------------------------------------------------------------------------
-- Recado: pais e equipe deixam só o próprio; ninguém escreve na vaga deles
-- -----------------------------------------------------------------------------
create or replace function public.bot_save_guest_message(
  p_phone text,
  p_body text,
  p_signature text default null,
  p_source text default 'text',
  p_wa_message_id text default null,
  p_for_guest_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- -----------------------------------------------------------------------------
-- Busca por nome, sugestões e vínculo por nome: só convidados
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

  select count(*) into v_exact from public.guests g where g.role = 'guest' and g.name_search = v_query;
  if v_exact > 1 then
    return jsonb_build_object('status', 'ambiguous');
  end if;

  select g.id, g.full_name, g.phone_e164 is not null as has_phone,
         case when g.name_search = v_query then 1.0
              else (extensions.similarity(v_query, g.name_search)
                    + extensions.word_similarity(v_query, g.name_search)) / 2 end as score
    into v_best
    from public.guests g
   where g.role = 'guest'
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
     where g.id <> v_best.id
       and g.role = 'guest';
    if v_second_score is not null and v_best.score - v_second_score < 0.1 then
      return jsonb_build_object('status', 'ambiguous');
    end if;
  end if;

  return jsonb_build_object(
    'status', 'found',
    'guest', jsonb_build_object('id', v_best.id, 'full_name', v_best.full_name, 'has_phone', v_best.has_phone));
end;
$$;

create or replace function public.bot_suggest_guest_names(p_name text, p_limit integer default 3)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
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
$$;

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
$$;

-- -----------------------------------------------------------------------------
-- Relatório: só convidados nas contagens e nas famílias (os recados contam todos)
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
$$;

revoke all on function public.bot_ensure_special_contact(text, text) from public, anon, authenticated;
grant execute on function public.bot_ensure_special_contact(text, text) to service_role;
