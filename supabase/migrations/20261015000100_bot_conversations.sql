-- =============================================================================
--  Conversas e memória da Professora Sof.IA
-- =============================================================================
--  A memória é sempre POR CONTATO (telefone do WhatsApp) e nunca cruza com a de
--  outra pessoa. A situação real da confirmação vem de public.guests, não daqui.
--   • wa_contacts: um por telefone; trava de processamento e contadores de uso.
--   • wa_inbox: mensagens recebidas, idempotente pelo id da mensagem.
--   • wa_sessions + wa_session_messages: histórico append-only enviado ao modelo
--     (inclui os blocos de raciocínio, que não podem ser editados) e o resumo
--     gerado ao encerrar a sessão.
--   • contact_notes: fatos duradouros anotados pelo agente.
--  LGPD: dados mínimos; public.bot_purge_conversations() apaga tudo isto.
-- =============================================================================

create table if not exists public.wa_contacts (
  phone text primary key check (phone ~ '^[1-9]\d{7,14}$'),
  display_name text check (display_name is null or char_length(display_name) <= 80),
  preferred_name text check (preferred_name is null or char_length(preferred_name) <= 60),
  -- Vínculo feito pela busca por nome (convidado sem telefone na lista).
  linked_guest_id uuid unique references public.guests (id) on delete set null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  lease_until timestamptz,
  turns_day date,
  turns_count integer not null default 0
);

comment on column public.wa_contacts.phone is 'Número como o WhatsApp entrega: só dígitos, com o código do país.';
comment on column public.wa_contacts.lease_until is 'Trava: só um processamento por telefone de cada vez.';

-- Turnos do agente por dia (teto global de custo).
create table if not exists public.bot_usage (
  day date primary key,
  turns integer not null default 0
);

create table if not exists public.wa_inbox (
  id bigint generated always as identity primary key,
  wa_message_id text not null unique check (char_length(wa_message_id) between 1 and 128),
  phone text not null references public.wa_contacts (phone) on delete cascade,
  kind text not null check (kind in ('text', 'audio', 'image', 'sticker', 'other')),
  body text check (body is null or char_length(body) <= 4000),
  audio_seconds integer check (audio_seconds is null or audio_seconds >= 0),
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists wa_inbox_pending_idx on public.wa_inbox (phone, id) where processed_at is null;

create table if not exists public.wa_sessions (
  id uuid primary key default gen_random_uuid(),
  phone text not null references public.wa_contacts (phone) on delete cascade,
  started_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  turns integer not null default 0,
  closed_at timestamptz,
  summary text check (summary is null or char_length(summary) <= 2000)
);

-- No máximo uma sessão aberta por contato.
create unique index if not exists wa_sessions_one_open_idx on public.wa_sessions (phone) where closed_at is null;
create index if not exists wa_sessions_phone_idx on public.wa_sessions (phone, started_at desc);

create table if not exists public.wa_session_messages (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.wa_sessions (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content jsonb not null check (jsonb_typeof(content) in ('string', 'array')),
  created_at timestamptz not null default now()
);

create index if not exists wa_session_messages_session_idx on public.wa_session_messages (session_id, id);

-- Histórico append-only: editar mensagens antigas invalidaria o raciocínio do modelo.
create or replace function public.forbid_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'append_only' using errcode = 'P0001';
end;
$$;

drop trigger if exists wa_session_messages_append_only on public.wa_session_messages;
create trigger wa_session_messages_append_only
  before update on public.wa_session_messages
  for each row execute function public.forbid_update();

create table if not exists public.contact_notes (
  id bigint generated always as identity primary key,
  phone text not null references public.wa_contacts (phone) on delete cascade,
  note text not null check (char_length(note) between 1 and 200),
  created_at timestamptz not null default now(),
  constraint contact_notes_unique unique (phone, note)
);

alter table public.wa_contacts enable row level security;
alter table public.bot_usage enable row level security;
alter table public.wa_inbox enable row level security;
alter table public.wa_sessions enable row level security;
alter table public.wa_session_messages enable row level security;
alter table public.contact_notes enable row level security;

revoke all on table
  public.wa_contacts, public.bot_usage, public.wa_inbox,
  public.wa_sessions, public.wa_session_messages, public.contact_notes
  from anon, authenticated;
revoke all on function public.forbid_update() from public, anon, authenticated;
