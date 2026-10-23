-- =============================================================================
--  Recados para a Sofia ("O Corujal")
-- =============================================================================
--  O convidado deixa um recado pela Professora Aifos no WhatsApp. Como nas outras
--  funções do bot, o autor nunca vem do modelo: sai do TELEFONE do remetente
--  (public.bot_actor). Quem não está na lista não deixa recado.
--
--  Um recado por pessoa: mandar de novo substitui. Os organizadores leem pelo
--  comando "recados" (bot_guest_messages) e o Livro de Recados sai do mesmo lugar
--  (scripts/messages-book.mjs). A limpeza de conversas (LGPD) NÃO apaga recados:
--  eles são o presente da Sofia e ficam ligados ao convidado, não ao telefone.
-- =============================================================================

create table if not exists public.guest_messages (
  id bigint generated always as identity primary key,
  guest_id uuid not null unique references public.guests (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 1000),
  signature text check (signature is null or char_length(signature) between 1 and 80),
  source text not null default 'text' check (source in ('text', 'audio')),
  wa_message_id text,
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.guest_messages is
  'Recados dos convidados para a Sofia, recolhidos pela Professora Aifos. Um por convidado.';
comment on column public.guest_messages.hidden is
  'Ocultado pelos organizadores: some do comando "recados" e do Livro de Recados.';

drop trigger if exists guest_messages_set_updated_at on public.guest_messages;
create trigger guest_messages_set_updated_at
  before update on public.guest_messages
  for each row execute function public.set_updated_at();

alter table public.guest_messages enable row level security;
revoke all on table public.guest_messages from anon, authenticated;

-- -----------------------------------------------------------------------------
-- Guardar (ou trocar) o recado do remetente
-- -----------------------------------------------------------------------------
create or replace function public.bot_save_guest_message(
  p_phone text,
  p_body text,
  p_signature text default null,
  p_source text default 'text',
  p_wa_message_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor record;
  v_body text := btrim(regexp_replace(coalesce(p_body, ''), '[ \t]+', ' ', 'g'));
  v_signature text := nullif(btrim(regexp_replace(coalesce(p_signature, ''), '\s+', ' ', 'g')), '');
  v_replaced boolean;
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

  v_replaced := exists (select 1 from public.guest_messages m where m.guest_id = v_actor.guest_id);

  insert into public.guest_messages (guest_id, body, signature, source, wa_message_id)
  values (v_actor.guest_id, v_body, v_signature, p_source, p_wa_message_id)
  on conflict (guest_id) do update
     set body = excluded.body,
         signature = excluded.signature,
         source = excluded.source,
         wa_message_id = excluded.wa_message_id,
         hidden = false;

  return jsonb_build_object('ok', true, 'replaced', v_replaced);
end;
$$;

-- -----------------------------------------------------------------------------
-- Situação da família: igual à anterior, mais o recado DO PRÓPRIO remetente
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
         and (v_actor.verified_by = 'phone' or g.id = v_actor.guest_id)),
    'message', (
      select jsonb_build_object('body', m.body, 'signature', m.signature, 'updated_at', m.updated_at)
        from public.guest_messages m
       where m.guest_id = v_actor.guest_id));
end;
$$;

-- -----------------------------------------------------------------------------
-- Recados para os organizadores e para o Livro (sem os ocultos, por chegada)
-- -----------------------------------------------------------------------------
create or replace function public.bot_guest_messages()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'full_name', g.full_name,
           'household', h.label,
           'signature', m.signature,
           'body', m.body,
           'source', m.source,
           'created_at', m.created_at,
           'updated_at', m.updated_at)
         order by m.created_at, m.id), '[]'::jsonb)
    from public.guest_messages m
    join public.guests g on g.id = m.guest_id
    join public.households h on h.id = g.household_id
   where not m.hidden
$$;

-- -----------------------------------------------------------------------------
-- Relatório: igual ao anterior, mais a contagem de recados
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
    'messages', (
      select jsonb_build_object(
        'total', count(*),
        'last_24h', count(*) filter (where m.updated_at >= now() - interval '24 hours'))
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
                   from public.guests g where g.household_id = h.id))
             order by h.label)
        from public.households h
       where exists (select 1 from public.guests g where g.household_id = h.id)), '[]'::jsonb))
$$;

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.bot_save_guest_message(text, text, text, text, text)',
    'public.bot_household_status(text)',
    'public.bot_guest_messages()',
    'public.bot_report()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end;
$$;
