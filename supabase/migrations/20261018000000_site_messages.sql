-- =============================================================================
-- O Salão Principal: recados aprovados pendurados no site como cartas flutuantes.
--
-- Os organizadores aprovam cada recado pelo WhatsApp ("publicar 7" / "retirar 7").
-- O site lê por uma Edge Function pública (site-messages), que chama
-- bot_site_messages() com o service_role: anon/authenticated continuam sem
-- acesso a nada. Até unseal_at (dia da festa) as cartas ficam SELADAS: o texto
-- não sai do banco, só quantas são e de quem.
-- Ver docs/arquitetura.md#o-salao-principal.
-- =============================================================================

alter table public.guest_messages
  add column if not exists public_id uuid not null default gen_random_uuid(),
  add column if not exists approved_at timestamptz;

create unique index if not exists guest_messages_public_id_key on public.guest_messages (public_id);

comment on column public.guest_messages.public_id is
  'Identificador opaco enviado ao site (o id sequencial não sai do banco).';
comment on column public.guest_messages.approved_at is
  'Aprovado pelos organizadores para o Salão Principal do site; nulo = aguardando.';

-- Trocar o texto ou a assinatura devolve o recado à fila de aprovação.
create or replace function public.guest_messages_reset_approval()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.body is distinct from old.body or new.signature is distinct from old.signature then
    new.approved_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists guest_messages_reset_approval on public.guest_messages;
create trigger guest_messages_reset_approval
  before update on public.guest_messages
  for each row execute function public.guest_messages_reset_approval();

-- -----------------------------------------------------------------------------
-- Quando os selos se rompem (uma linha só). Para mudar:
--   update public.message_wall_settings set unseal_at = '2027-02-20 00:00-03' where id = 1;
-- -----------------------------------------------------------------------------
create table if not exists public.message_wall_settings (
  id smallint primary key default 1 check (id = 1),
  unseal_at timestamptz not null
);

insert into public.message_wall_settings (id, unseal_at)
values (1, '2027-02-20 00:00:00-03')
on conflict (id) do nothing;

alter table public.message_wall_settings enable row level security;
revoke all on table public.message_wall_settings from anon, authenticated;

-- -----------------------------------------------------------------------------
-- O que o site recebe: só aprovados e não ocultos; selado = sem o texto
-- -----------------------------------------------------------------------------
create or replace function public.bot_site_messages()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
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
$$;

-- -----------------------------------------------------------------------------
-- Aprovar ("publicar 7") ou retirar ("retirar 7") — comando dos organizadores
-- -----------------------------------------------------------------------------
create or replace function public.bot_set_message_approval(p_id bigint, p_approved boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- -----------------------------------------------------------------------------
-- Lista dos organizadores e do Livro: igual à anterior, mais número e aprovação
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
           'created_at', m.created_at,
           'updated_at', m.updated_at)
         order by m.created_at, m.id), '[]'::jsonb)
    from public.guest_messages m
    join public.guests g on g.id = m.guest_id
    join public.households h on h.id = g.household_id
   where not m.hidden
$$;

-- -----------------------------------------------------------------------------
-- Relatório: igual ao anterior, mais os recados aguardando aprovação
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
    'public.guest_messages_reset_approval()',
    'public.bot_site_messages()',
    'public.bot_set_message_approval(bigint, boolean)',
    'public.bot_guest_messages()',
    'public.bot_report()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end;
$$;
