-- =============================================================================
--  Canal do WhatsApp (Evolution API): o que o webhook e o cron precisam
-- =============================================================================
--  1. wa_inbox.remote_jid: o identificador da conversa como o WhatsApp entrega
--     ("…@s.whatsapp.net" ou "…@lid"). Reações e confirmação de leitura precisam
--     dele; o telefone continua sendo a identidade.
--  2. bot_contact_card: quem é o contato, para os avisos aos organizadores.
--  3. bot_inbox_stalled: mensagens esquecidas na fila (o processamento caiu no
--     meio); o cron as entrega de novo ao orquestrador.
--  4. Segredo do cron: nasce e mora no Vault do Supabase. O pg_cron o lê para
--     chamar a Edge Function, que o confere com bot_cron_secret_ok. Nenhum
--     arquivo nem variável de ambiente guarda esse segredo.
-- =============================================================================

alter table public.wa_inbox
  add column if not exists remote_jid text check (remote_jid is null or char_length(remote_jid) <= 128);

comment on column public.wa_inbox.remote_jid is
  'Conversa no WhatsApp (…@s.whatsapp.net ou …@lid), para reagir e marcar como lida.';

-- Mesma função da fase 1, com o JID. Assinatura nova: a antiga sai (sem sobrecarga ambígua).
drop function if exists public.bot_inbox_add(text, text, text, text, text, integer);

create or replace function public.bot_inbox_add(
  p_wa_message_id text,
  p_phone text,
  p_push_name text,
  p_kind text,
  p_body text default null,
  p_audio_seconds integer default null,
  p_remote_jid text default null
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

  insert into public.wa_inbox (wa_message_id, phone, kind, body, audio_seconds, remote_jid)
  values (p_wa_message_id, v_phone, p_kind, left(p_body, 4000), p_audio_seconds, left(p_remote_jid, 128))
  on conflict (wa_message_id) do nothing
  returning id into v_id;

  return jsonb_build_object('inserted', v_id is not null, 'id', v_id);
end;
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
           'remote_jid', i.remote_jid,
           'kind', i.kind,
           'body', i.body,
           'audio_seconds', i.audio_seconds,
           'received_at', i.received_at)
         order by i.id), '[]'::jsonb)
    from public.wa_inbox i
   where i.phone = public.phone_digits(p_phone) and i.processed_at is null
$$;

-- Quem é o contato (para os avisos aos organizadores): nome no WhatsApp e, se
-- identificado, o convidado e a família.
create or replace function public.bot_contact_card(p_phone text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
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
$$;

-- Telefones com mensagem parada na fila há algum tempo e sem processamento em
-- andamento (lease livre): o orquestrador caiu antes de responder.
create or replace function public.bot_inbox_stalled(p_min_age_seconds integer, p_limit integer default 20)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
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
$$;

-- -----------------------------------------------------------------------------
-- Segredo do cron (Vault). Fora do Supabase (testes no PGlite) não há Vault:
-- a função responde falso e nada é criado.
-- -----------------------------------------------------------------------------
do $$
begin
  -- Ifs aninhados: o PL/pgSQL só prepara o comando de dentro se chegar nele.
  if exists (select 1 from pg_namespace where nspname = 'vault') then
    if not exists (select 1 from vault.secrets where name = 'sofia_cron_secret') then
      perform vault.create_secret(
        encode(extensions.gen_random_bytes(32), 'hex'),
        'sofia_cron_secret',
        'Professora Sof.IA: o pg_cron envia; a Edge Function whatsapp-cron confere (bot_cron_secret_ok).');
    end if;
  end if;
end;
$$;

create or replace function public.bot_cron_secret_ok(p_secret text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
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
$$;

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.bot_inbox_add(text, text, text, text, text, integer, text)',
    'public.bot_inbox_pending(text)',
    'public.bot_contact_card(text)',
    'public.bot_inbox_stalled(integer, integer)',
    'public.bot_cron_secret_ok(text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end;
$$;
