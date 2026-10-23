-- =============================================================================
-- Lista de presentes (pergaminho do Capítulo VIII), paga na página segura do Asaas.
--
-- Fluxo: o site chama a Edge Function pública gift-checkout, que confere o preço
-- pela cópia da lista no servidor, grava o pedido aqui (pending), cria o checkout
-- no Asaas e devolve o link. O Asaas avisa o resultado na Edge Function
-- asaas-webhook (token no cabeçalho), que muda o status aqui. Só pedidos PAGOS
-- contam na vaquinha e entram no Livro de Recados.
--
-- Dados mínimos (LGPD): do pagador não se guarda nada além da assinatura que ele
-- escreveu, se quis (nome, CPF e e-mail ficam só no Asaas). O IP vira um hash com
-- sal secreto, usado só para limitar tentativas e apagado em 24 h. Pedidos não
-- pagos (com a mensagem) somem em 48 h. A limpeza roda a cada pedido criado.
-- anon/authenticated não têm acesso a nada: tudo passa pelas funções bot_*
-- (só service_role, usadas pelas Edge Functions).
-- Ver docs/arquitetura.md#lista-de-presentes.
-- =============================================================================

create table if not exists public.gift_orders (
  id uuid primary key default gen_random_uuid(),
  gift_id text not null check (gift_id ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$'),
  gift_name text not null check (char_length(gift_name) between 1 and 80),
  kind text not null check (kind in ('quota', 'fund')),
  -- Quanto a família recebe (a contribuição) e quanto foi cobrado (com os custos do Asaas).
  base_cents integer not null check (base_cents between 1 and 10000000),
  charged_cents integer not null check (charged_cents >= base_cents and charged_cents <= 11000000),
  message text check (message is null or char_length(message) between 1 and 500),
  signature text check (signature is null or char_length(signature) between 1 and 60),
  anonymous boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'paid', 'canceled', 'expired', 'refunded')),
  asaas_checkout_id text unique check (asaas_checkout_id is null or char_length(asaas_checkout_id) between 1 and 100),
  ip_hash text check (ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz,
  -- Assinatura só com mensagem; em segredo, sem assinatura.
  constraint gift_orders_signature_needs_message check (message is not null or (signature is null and not anonymous)),
  constraint gift_orders_secret_has_no_signature check (not (anonymous and signature is not null))
);

create index if not exists gift_orders_ip_recent on public.gift_orders (ip_hash, created_at) where ip_hash is not null;
create index if not exists gift_orders_status on public.gift_orders (status, kind);

comment on table public.gift_orders is
  'Presentes da lista (checkout do Asaas). Só os pagos contam na vaquinha e vão para o Livro de Recados.';

-- Eventos do webhook já processados (o Asaas entrega "pelo menos uma vez").
create table if not exists public.gift_webhook_events (
  event_id text primary key check (char_length(event_id) between 1 and 120),
  event text not null,
  received_at timestamptz not null default now()
);

alter table public.gift_orders enable row level security;
alter table public.gift_webhook_events enable row level security;
revoke all on table public.gift_orders from anon, authenticated;
revoke all on table public.gift_webhook_events from anon, authenticated;

-- -----------------------------------------------------------------------------
-- Novo pedido (gift-checkout), com limite de tentativas e a limpeza de carona
-- -----------------------------------------------------------------------------
create or replace function public.bot_create_gift_order(
  p_gift_id text,
  p_gift_name text,
  p_kind text,
  p_base_cents integer,
  p_charged_cents integer,
  p_message text,
  p_signature text,
  p_anonymous boolean,
  p_ip_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_message text := nullif(btrim(p_message), '');
  v_signature text := nullif(btrim(p_signature), '');
  v_anonymous boolean := coalesce(p_anonymous, false);
  v_id uuid;
begin
  -- Limpeza: pedidos não pagos somem em 48 h (com a mensagem); o hash do IP, em 24 h.
  delete from public.gift_orders o
   where o.status in ('pending', 'canceled', 'expired')
     and o.created_at < now() - interval '48 hours';
  update public.gift_orders o
     set ip_hash = null
   where o.ip_hash is not null
     and o.created_at < now() - interval '24 hours';
  delete from public.gift_webhook_events e
   where e.received_at < now() - interval '90 days';

  -- Limites: 5 pedidos por IP em 10 minutos e 300 por dia no total.
  if p_ip_hash is not null and (
       select count(*) from public.gift_orders o
        where o.ip_hash = p_ip_hash and o.created_at > now() - interval '10 minutes') >= 5 then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;
  if (select count(*) from public.gift_orders o where o.created_at > now() - interval '24 hours') >= 300 then
    return jsonb_build_object('ok', false, 'error', 'busy');
  end if;

  if v_message is null then
    v_signature := null;
    v_anonymous := false;
  elsif v_anonymous then
    v_signature := null;
  elsif v_signature is null then
    return jsonb_build_object('ok', false, 'error', 'signature_required');
  end if;

  insert into public.gift_orders (gift_id, gift_name, kind, base_cents, charged_cents, message, signature, anonymous, ip_hash)
  values (p_gift_id, btrim(p_gift_name), p_kind, p_base_cents, p_charged_cents, v_message, v_signature, v_anonymous, p_ip_hash)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id);
exception
  when check_violation or not_null_violation then
    return jsonb_build_object('ok', false, 'error', 'invalid');
end;
$$;

-- O checkout do Asaas foi criado: guarda o id dele (é por ele que o webhook acha o pedido).
create or replace function public.bot_attach_gift_checkout(p_order_id uuid, p_checkout_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.gift_orders o
     set asaas_checkout_id = p_checkout_id, updated_at = now()
   where o.id = p_order_id
     and o.status = 'pending'
     and o.asaas_checkout_id is null;
  return jsonb_build_object('ok', found);
end;
$$;

-- O Asaas recusou ou não respondeu: o pedido (e a mensagem) não ficam no banco.
create or replace function public.bot_discard_gift_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.gift_orders o
   where o.id = p_order_id
     and o.status = 'pending'
     and o.asaas_checkout_id is null;
  return jsonb_build_object('ok', found);
end;
$$;

-- -----------------------------------------------------------------------------
-- Evento do webhook do Asaas (idempotente, só transições válidas)
--   pending  → paid | canceled | expired
--   canceled | expired → paid   (Pix pago no limite do prazo)
--   paid     → refunded
-- -----------------------------------------------------------------------------
create or replace function public.bot_apply_gift_event(p_event_id text, p_event text, p_checkout_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new text;
  v_order record;
begin
  v_new := case p_event
    when 'CHECKOUT_PAID' then 'paid'
    when 'CHECKOUT_CANCELED' then 'canceled'
    when 'CHECKOUT_EXPIRED' then 'expired'
    when 'PAYMENT_REFUNDED' then 'refunded'
    when 'PAYMENT_CHARGEBACK_REQUESTED' then 'refunded'
    else null
  end;
  if v_new is null then
    return jsonb_build_object('ok', true, 'ignored', true);
  end if;
  if nullif(btrim(p_event_id), '') is null or nullif(btrim(p_checkout_id), '') is null then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  insert into public.gift_webhook_events (event_id, event) values (p_event_id, p_event)
  on conflict (event_id) do nothing;
  if not found then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;

  select o.id, o.status into v_order
    from public.gift_orders o
   where o.asaas_checkout_id = p_checkout_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if v_order.status = v_new
     or (v_new = 'paid' and v_order.status = 'refunded')
     or (v_new in ('canceled', 'expired') and v_order.status in ('paid', 'refunded'))
     or (v_new = 'refunded' and v_order.status <> 'paid') then
    return jsonb_build_object('ok', true, 'changed', false, 'status', v_order.status);
  end if;

  update public.gift_orders o
     set status = v_new,
         paid_at = case when v_new = 'paid' then now() else o.paid_at end,
         updated_at = now()
   where o.id = v_order.id;

  return jsonb_build_object('ok', true, 'changed', true, 'status', v_new, 'previous', v_order.status);
end;
$$;

-- -----------------------------------------------------------------------------
-- Leituras: progresso das vaquinhas (site-gifts) e recados pagos (Livro de Recados)
-- -----------------------------------------------------------------------------
create or replace function public.bot_gift_progress()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('gift_id', p.gift_id, 'raised_cents', p.raised) order by p.gift_id), '[]'::jsonb)
    from (
      select o.gift_id, sum(o.base_cents)::bigint as raised
        from public.gift_orders o
       where o.kind = 'fund' and o.status = 'paid'
       group by o.gift_id
    ) p
$$;

create or replace function public.bot_gift_messages()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'gift_name', o.gift_name,
           'signature', o.signature,
           'anonymous', o.anonymous,
           'body', o.message,
           'paid_at', o.paid_at)
         order by o.paid_at, o.id), '[]'::jsonb)
    from public.gift_orders o
   where o.status = 'paid'
     and o.message is not null
$$;

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.bot_create_gift_order(text, text, text, integer, integer, text, text, boolean, text)',
    'public.bot_attach_gift_checkout(uuid, text)',
    'public.bot_discard_gift_order(uuid)',
    'public.bot_apply_gift_event(text, text, text)',
    'public.bot_gift_progress()',
    'public.bot_gift_messages()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end;
$$;
