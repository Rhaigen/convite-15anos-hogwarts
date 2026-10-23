-- =============================================================================
--  Recados pela família
-- =============================================================================
--  Um responsável pela família (identificado pelo telefone e com
--  can_answer_for_household, o mesmo critério da confirmação de presença) pode
--  deixar o recado de outro membro: em nome do filho pequeno, da esposa, ou um
--  recado "da família toda" na vaga de alguém. Continua UM recado por pessoa
--  (guest_id único): família de 5 tem no máximo 5 recados.
--
--  Quem pode trocar um recado que já existe:
--    - o dono (a pessoa em nome de quem está), sempre;
--    - quem escreveu, enquanto o dono não reescrever (written_by = remetente).
--  Quando o dono grava o próprio recado, written_by passa a ser ele e só ele
--  troca dali em diante. Outro responsável nunca troca recado escrito por outra
--  pessoa. Ver docs/arquitetura.md#recados.
-- =============================================================================

alter table public.guest_messages
  add column if not exists written_by uuid references public.guests (id) on delete set null;

update public.guest_messages set written_by = guest_id where written_by is null;

comment on column public.guest_messages.written_by is
  'Quem gravou o recado pela Aifos (o dono ou um responsável pela família). Nulo: quem escreveu saiu da lista; só o dono troca.';

-- A versão antiga (5 argumentos) sai para não haver duas assinaturas: a nova
-- aceita as mesmas chamadas (p_for_guest_id tem padrão).
drop function if exists public.bot_save_guest_message(text, text, text, text, text);

-- -----------------------------------------------------------------------------
-- Guardar (ou trocar) um recado: do remetente ou, se ele for responsável, de
-- outro membro da família
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
  v_target uuid;
  v_target_name text;
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
  select g.full_name into v_target_name
    from public.guests g
   where g.id = v_target
     and g.household_id = v_actor.household_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_in_household');
  end if;
  -- Pelos outros, só quem confirmou pelo telefone e responde pela família.
  if v_target <> v_actor.guest_id
     and not (v_actor.verified_by = 'phone' and v_actor.can_answer_for_household) then
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
-- Situação da família: o recado passa a vir por membro. O texto só aparece para
-- quem pode trocá-lo (o dono ou quem escreveu); dos outros, só que existe.
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
               'can_answer', g.id = v_actor.guest_id or v_actor.can_answer_for_household,
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
         and (v_actor.verified_by = 'phone' or g.id = v_actor.guest_id)));
end;
$$;

-- -----------------------------------------------------------------------------
-- Lista dos organizadores e do Livro: igual à anterior, mais quem enviou quando
-- não foi o próprio dono
-- -----------------------------------------------------------------------------
create or replace function public.bot_guest_messages()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
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
$$;

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.bot_save_guest_message(text, text, text, text, text, uuid)',
    'public.bot_household_status(text)',
    'public.bot_guest_messages()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end;
$$;
