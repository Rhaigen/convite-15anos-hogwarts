-- =============================================================================
--  Lista de convidados por família — confirmação pela Professora Sof.IA (WhatsApp)
-- =============================================================================
--  Substitui o formulário público (submit_rsvp), que aceitava qualquer nome.
--  Agora só quem está na lista confirma, e cada família (household) responde
--  pelos seus membros: pai/mãe pelos filhos, cônjuges um pelo outro. Menores
--  costumam não ter telefone e são respondidos pelos responsáveis.
--
--  Modelo de segurança (igual ao anterior, mais restrito):
--   • RLS habilitado em todas as tabelas, sem políticas, e privilégios revogados
--     de anon/authenticated: o site não lê nem escreve nada aqui.
--   • Toda operação passa por funções SECURITY DEFINER (search_path vazio)
--     executáveis só pelo service_role, usado pelas Edge Functions do bot.
--   • As regras (mesma família, quem pode responder, prazo) ficam no banco,
--     não no modelo de IA.
-- =============================================================================

-- Busca tolerante a erros de digitação ("Ana Souza" ≈ "Ana Sousa").
create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;

-- -----------------------------------------------------------------------------
-- Formulário antigo: removido (a migração 20261012000000 fica como histórico).
-- -----------------------------------------------------------------------------
drop view if exists public.rsvp_latest_responses;
drop function if exists public.submit_rsvp(uuid, text, text, integer, text);
drop table if exists public.rsvps;

alter table public.rsvp_settings
  drop column if exists max_companions,
  drop column if exists allow_message,
  drop column if exists max_per_minute,
  drop column if exists max_per_name_per_hour,
  -- Teto de turnos do agente por dia (custo e abuso), no fuso de São Paulo.
  add column if not exists turns_per_phone_per_day integer not null default 40
    check (turns_per_phone_per_day > 0),
  add column if not exists turns_per_day integer not null default 800
    check (turns_per_day > 0);

comment on table public.rsvp_settings is
  'Política da confirmação (linha única): aceitar respostas, prazo e tetos de uso do agente.';

-- -----------------------------------------------------------------------------
-- Normalização (funções puras, usadas em colunas geradas e nas buscas)
-- -----------------------------------------------------------------------------

-- "  José  D'Ávila " → "jose d avila". Sem depender da extensão unaccent.
create or replace function public.normalize_name(p_name text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select btrim(regexp_replace(
    translate(lower(coalesce(p_name, '')),
              'áàâãäåéèêëíìîïóòôõöúùûüçñý',
              'aaaaaaeeeeiiiiooooouuuucny'),
    '[^a-z0-9]+', ' ', 'g'))
$$;

-- Telefone digitado na planilha → E.164. Brasil: "(31) 8888-7777" e
-- "31 98888-7777" viram "+5531988887777" (celular de 8 dígitos ganha o 9).
-- Números estrangeiros precisam do "+" e do código do país. Inválido → null.
create or replace function public.normalize_phone(p_phone text)
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
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
$$;

-- Número como o WhatsApp entrega (só dígitos, às vezes sem o 9 de celulares
-- brasileiros antigos) → formas E.164 equivalentes para procurar na lista.
create or replace function public.phone_variants(p_phone text)
returns text[]
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when d ~ '^55\d{2}9\d{8}$'    then array['+' || d, '+' || left(d, 4) || right(d, 8)]
    when d ~ '^55\d{2}[6-9]\d{7}$' then array['+' || d, '+' || left(d, 4) || '9' || right(d, 8)]
    when d ~ '^[1-9]\d{7,14}$'     then array['+' || d]
    else array[]::text[]
  end
  from (select regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as d) as x
$$;

-- -----------------------------------------------------------------------------
-- Famílias e convidados
-- -----------------------------------------------------------------------------
create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  label text not null unique check (char_length(btrim(label)) between 2 and 80),
  notes text check (notes is null or char_length(notes) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.households is 'Famílias convidadas. O rótulo é a chave da importação da planilha.';

create table if not exists public.guests (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  full_name text not null check (char_length(btrim(full_name)) between 2 and 120),
  name_search text generated always as (public.normalize_name(full_name)) stored,
  phone_e164 text unique check (phone_e164 is null or phone_e164 ~ '^\+[1-9]\d{7,14}$'),
  relationship text check (relationship is null or char_length(relationship) <= 40),
  is_minor boolean not null default false,
  can_answer_for_household boolean not null default true,
  rsvp_status text not null default 'pending' check (rsvp_status in ('pending', 'attending', 'declined')),
  rsvp_updated_at timestamptz,
  rsvp_updated_by uuid references public.guests (id) on delete set null,
  rsvp_channel text check (rsvp_channel is null or rsvp_channel in ('whatsapp', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint guests_name_unique_in_household unique (household_id, name_search),
  constraint guests_minor_cannot_answer_for_household check (not (is_minor and can_answer_for_household))
);

comment on column public.guests.phone_e164 is
  'Opcional (menores costumam não ter). Um telefone identifica um único convidado.';
comment on column public.guests.can_answer_for_household is
  'Pode confirmar pelos outros membros da família. Nunca verdadeiro para menores.';

create index if not exists guests_household_idx on public.guests (household_id);

-- Auditoria de toda mudança de resposta.
create table if not exists public.rsvp_events (
  id bigint generated always as identity primary key,
  guest_id uuid not null references public.guests (id) on delete cascade,
  previous_status text not null,
  new_status text not null,
  actor_guest_id uuid references public.guests (id) on delete set null,
  origin_phone text,
  wa_message_id text,
  channel text not null check (channel in ('whatsapp', 'admin')),
  created_at timestamptz not null default now()
);

create index if not exists rsvp_events_guest_idx on public.rsvp_events (guest_id, created_at desc);

drop trigger if exists households_set_updated_at on public.households;
create trigger households_set_updated_at
  before update on public.households
  for each row execute function public.set_updated_at();

drop trigger if exists guests_set_updated_at on public.guests;
create trigger guests_set_updated_at
  before update on public.guests
  for each row execute function public.set_updated_at();

alter table public.households enable row level security;
alter table public.guests enable row level security;
alter table public.rsvp_events enable row level security;

revoke all on table public.households, public.guests, public.rsvp_events from anon, authenticated;
-- A migração anterior revogou só de PUBLIC; o Supabase concede EXECUTE direto a anon/authenticated.
revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.normalize_name(text), public.normalize_phone(text), public.phone_variants(text)
  from public, anon, authenticated;
grant execute on function public.normalize_name(text), public.normalize_phone(text), public.phone_variants(text)
  to service_role;
