-- =============================================================================
--  Conversas da Sof.IA: mensagens "system" no histórico e retomada
-- =============================================================================
--  1. A cada turno, o código envia ao modelo o contexto verificado (quem é o
--     remetente, a família, prazo, memória) como uma mensagem role = 'system'
--     logo depois da mensagem do convidado. Ela fica gravada no histórico: o
--     histórico é append-only e reenviado igual, ou o raciocínio do modelo
--     (blocos thinking) e o cache deixam de valer.
--  2. Retomada: se a conversa parou com a Sof.IA esperando resposta (uma
--     pergunta sem resposta, uma confirmação pela metade), ela escreve UMA vez
--     depois de um tempo. `followed_up` impede repetir até a pessoa responder.
-- =============================================================================

alter table public.wa_session_messages
  drop constraint if exists wa_session_messages_role_check;

alter table public.wa_session_messages
  add constraint wa_session_messages_role_check check (role in ('user', 'assistant', 'system'));

alter table public.wa_sessions
  add column if not exists followed_up boolean not null default false;

comment on column public.wa_sessions.followed_up is
  'A Sof.IA já retomou esta conversa desde a última mensagem do convidado.';

-- Mesma função da fase 1; agora uma mensagem do convidado libera nova retomada.
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
         turns = turns + case when p_new_turn then 1 else 0 end,
         followed_up = case when p_new_turn then false else followed_up end
   where id = p_session_id;
end;
$$;

-- Conversas paradas com a Sof.IA esperando: sessão aberta, última mensagem do
-- assistente, silêncio dentro da janela, sem retomada desde a última mensagem
-- do convidado, sem mensagem nova na fila e sem processamento em andamento.
-- Quem decide se há algo pendente é o agente; o código só escolhe candidatos.
create or replace function public.bot_followup_candidates(
  p_min_idle_minutes integer,
  p_max_idle_minutes integer,
  p_limit integer default 20
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
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
$$;

create or replace function public.bot_mark_followed_up(p_session_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.wa_sessions set followed_up = true where id = p_session_id
$$;

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.bot_append_messages(uuid, jsonb, boolean)',
    'public.bot_followup_candidates(integer, integer, integer)',
    'public.bot_mark_followed_up(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end;
$$;
