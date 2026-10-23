-- =============================================================================
--  Confirmação de presença (RSVP) — 15 anos de Sofia
-- =============================================================================
--  Modelo de segurança:
--   • RLS habilitado em todas as tabelas e NENHUMA política para anon/authenticated:
--     visitantes não conseguem ler, listar, alterar nem apagar registros.
--   • Privilégios de tabela revogados de anon/authenticated (defesa em profundidade).
--   • A única operação pública é a função submit_rsvp (SECURITY DEFINER), que
--     valida e normaliza os dados, aplica a política do evento (rsvp_settings),
--     limita a taxa de envios e é idempotente (client_request_id).
--   • A organização consulta as respostas pelo painel do Supabase (Table Editor /
--     SQL Editor), que usa credenciais administrativas — nunca pelo site.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Política do evento (linha única). Ajuste com UPDATE no SQL Editor, ex.:
--   update public.rsvp_settings set max_companions = 1 where id = 1;
-- Mantenha src/content/settings.ts (rsvpConfig) coerente com estes valores.
-- -----------------------------------------------------------------------------
create table if not exists public.rsvp_settings (
  id smallint primary key default 1 check (id = 1),
  accepting_responses boolean not null default true,
  max_companions smallint not null default 0 check (max_companions between 0 and 10),
  allow_message boolean not null default true,
  deadline timestamptz,
  max_per_minute integer not null default 30 check (max_per_minute > 0),
  max_per_name_per_hour integer not null default 3 check (max_per_name_per_hour > 0),
  updated_at timestamptz not null default now()
);

insert into public.rsvp_settings (id) values (1) on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- Respostas
-- -----------------------------------------------------------------------------
create table if not exists public.rsvps (
  id uuid primary key default gen_random_uuid(),
  client_request_id uuid not null unique,
  guest_name text not null,
  guest_name_normalized text generated always as (lower(regexp_replace(btrim(guest_name), '\s+', ' ', 'g'))) stored,
  attendance_status text not null,
  companions_count smallint not null default 0,
  message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rsvps_guest_name_length check (char_length(btrim(guest_name)) between 3 and 120),
  constraint rsvps_attendance_status_valid check (attendance_status in ('attending', 'declined')),
  constraint rsvps_companions_range check (companions_count between 0 and 10),
  constraint rsvps_declined_without_companions check (attendance_status = 'attending' or companions_count = 0),
  constraint rsvps_message_length check (message is null or char_length(message) <= 500)
);

comment on table public.rsvps is 'Confirmações de presença. Acesso público somente via public.submit_rsvp().';
comment on column public.rsvps.client_request_id is 'Gerado no navegador por tentativa de envio; torna reenvios idempotentes.';

create index if not exists rsvps_created_at_idx on public.rsvps (created_at desc);
create index if not exists rsvps_name_recent_idx on public.rsvps (guest_name_normalized, created_at desc);

-- updated_at automático
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists rsvps_set_updated_at on public.rsvps;
create trigger rsvps_set_updated_at
  before update on public.rsvps
  for each row execute function public.set_updated_at();

drop trigger if exists rsvp_settings_set_updated_at on public.rsvp_settings;
create trigger rsvp_settings_set_updated_at
  before update on public.rsvp_settings
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Row Level Security: habilitado, sem políticas públicas (negação por padrão).
-- -----------------------------------------------------------------------------
alter table public.rsvps enable row level security;
alter table public.rsvp_settings enable row level security;

revoke all on table public.rsvps from anon, authenticated;
revoke all on table public.rsvp_settings from anon, authenticated;

-- -----------------------------------------------------------------------------
-- Envio público controlado
-- Erros (campo `message` da resposta da API):
--   invalid_request | invalid_name | invalid_status | invalid_companions |
--   invalid_message (SQLSTATE 22023) · rsvp_closed | rate_limited (P0001)
-- -----------------------------------------------------------------------------
create or replace function public.submit_rsvp(
  p_client_request_id uuid,
  p_guest_name text,
  p_attendance_status text,
  p_companions_count integer default 0,
  p_message text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.rsvp_settings%rowtype;
  v_name text;
  v_message text;
  v_companions integer;
  v_id uuid;
  v_recent integer;
begin
  if p_client_request_id is null then
    raise exception 'invalid_request' using errcode = '22023';
  end if;

  -- Idempotência: reenviar a mesma tentativa (ex.: após falha de rede) não duplica.
  select r.id into v_id from public.rsvps r where r.client_request_id = p_client_request_id;
  if found then
    return jsonb_build_object('reference', upper(left(v_id::text, 8)), 'duplicate', true);
  end if;

  select * into v_settings from public.rsvp_settings s where s.id = 1;
  if not found
     or not v_settings.accepting_responses
     or (v_settings.deadline is not null and now() > v_settings.deadline) then
    raise exception 'rsvp_closed' using errcode = 'P0001';
  end if;

  v_name := btrim(regexp_replace(coalesce(p_guest_name, ''), '\s+', ' ', 'g'));
  if char_length(v_name) < 3 or char_length(v_name) > 120 or v_name !~ '[[:alpha:]]' then
    raise exception 'invalid_name' using errcode = '22023';
  end if;

  if p_attendance_status is null or p_attendance_status not in ('attending', 'declined') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;

  v_companions := coalesce(p_companions_count, 0);
  if p_attendance_status = 'declined' then
    v_companions := 0;
  end if;
  if v_companions < 0 or v_companions > v_settings.max_companions then
    raise exception 'invalid_companions' using errcode = '22023';
  end if;

  v_message := nullif(btrim(coalesce(p_message, '')), '');
  if not v_settings.allow_message then
    v_message := null;
  end if;
  if v_message is not null and char_length(v_message) > 500 then
    raise exception 'invalid_message' using errcode = '22023';
  end if;

  -- Proteção contra automação: limite global por minuto e por nome por hora.
  select count(*) into v_recent from public.rsvps r where r.created_at > now() - interval '1 minute';
  if v_recent >= v_settings.max_per_minute then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  select count(*) into v_recent
    from public.rsvps r
   where r.guest_name_normalized = lower(v_name)
     and r.created_at > now() - interval '1 hour';
  if v_recent >= v_settings.max_per_name_per_hour then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  insert into public.rsvps (client_request_id, guest_name, attendance_status, companions_count, message)
  values (p_client_request_id, v_name, p_attendance_status, v_companions, v_message)
  returning id into v_id;

  return jsonb_build_object('reference', upper(left(v_id::text, 8)), 'duplicate', false);
exception
  when unique_violation then
    -- Corrida entre duas requisições idênticas: devolve o registro já criado.
    select r.id into v_id from public.rsvps r where r.client_request_id = p_client_request_id;
    return jsonb_build_object('reference', upper(left(v_id::text, 8)), 'duplicate', true);
end;
$$;

comment on function public.submit_rsvp(uuid, text, text, integer, text) is
  'Único ponto de escrita pública do RSVP: valida, aplica a política do evento e limita a taxa.';

revoke all on function public.submit_rsvp(uuid, text, text, integer, text) from public;
grant execute on function public.submit_rsvp(uuid, text, text, integer, text) to anon, authenticated;

revoke all on function public.set_updated_at() from public;

-- -----------------------------------------------------------------------------
-- Visão para a organização: resposta mais recente de cada nome.
-- security_invoker = respeita RLS; sem privilégios para anon/authenticated.
-- -----------------------------------------------------------------------------
create or replace view public.rsvp_latest_responses
with (security_invoker = true) as
select distinct on (guest_name_normalized)
  guest_name,
  attendance_status,
  companions_count,
  message,
  created_at
from public.rsvps
order by guest_name_normalized, created_at desc;

revoke all on public.rsvp_latest_responses from anon, authenticated;
