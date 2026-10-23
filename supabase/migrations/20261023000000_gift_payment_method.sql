-- =============================================================================
-- Lista de presentes: a forma de pagamento passa a ser escolhida no site.
--
-- O pergaminho mostra dois botões (Pix / Cartão em até 6x), cada um com o total
-- daquela forma; a gift-checkout cria um checkout no Asaas só com a forma escolhida
-- e grava aqui qual foi. Pedidos de antes desta migração ficam com null.
-- Ver docs/arquitetura.md#lista-de-presentes.
-- =============================================================================

alter table public.gift_orders
  add column if not exists payment_method text
  check (payment_method is null or payment_method in ('pix', 'card'));

comment on column public.gift_orders.payment_method is
  'Botão escolhido no site: pix ou card (null = pedido de antes da escolha no site).';

-- A assinatura muda (novo parâmetro obrigatório): a versão antiga sai.
drop function if exists public.bot_create_gift_order(text, text, text, integer, integer, text, text, boolean, text);

create or replace function public.bot_create_gift_order(
  p_gift_id text,
  p_gift_name text,
  p_kind text,
  p_payment_method text,
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

  -- Pedido novo sempre diz a forma de pagamento.
  if p_payment_method is null or p_payment_method not in ('pix', 'card') then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  if v_message is null then
    v_signature := null;
    v_anonymous := false;
  elsif v_anonymous then
    v_signature := null;
  elsif v_signature is null then
    return jsonb_build_object('ok', false, 'error', 'signature_required');
  end if;

  insert into public.gift_orders (gift_id, gift_name, kind, payment_method, base_cents, charged_cents, message, signature, anonymous, ip_hash)
  values (p_gift_id, btrim(p_gift_name), p_kind, p_payment_method, p_base_cents, p_charged_cents, v_message, v_signature, v_anonymous, p_ip_hash)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id);
exception
  when check_violation or not_null_violation then
    return jsonb_build_object('ok', false, 'error', 'invalid');
end;
$$;

revoke all on function public.bot_create_gift_order(text, text, text, text, integer, integer, text, text, boolean, text) from public, anon, authenticated;
grant execute on function public.bot_create_gift_order(text, text, text, text, integer, integer, text, text, boolean, text) to service_role;
