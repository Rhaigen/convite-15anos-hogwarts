-- =============================================================================
-- Lista de presentes: quem deu cada presente, só para a família.
--
-- Quando o Asaas avisa que o checkout foi pago, a asaas-webhook busca o nome do
-- cliente na API do Asaas (o nome que o convidado preencheu ao pagar) e grava aqui.
-- Os organizadores leem com o comando "presentes" no WhatsApp (sem IA). O nome não
-- sai por nenhum outro caminho: nem site-gifts, nem o Salão, nem o Livro de Recados,
-- nem a Aifos. CPF e e-mail continuam só no Asaas. Pedidos não pagos (com o nome,
-- se houver) somem em 48 h, como antes.
-- Ver docs/arquitetura.md#lista-de-presentes.
-- =============================================================================

alter table public.gift_orders
  add column if not exists payer_name text
  check (payer_name is null or char_length(payer_name) between 1 and 120);

comment on column public.gift_orders.payer_name is
  'Nome de quem pagou (cliente no Asaas). Só para os organizadores, pelo comando "presentes".';

-- Grava o nome uma vez por pedido (o primeiro aviso vale; repetições não trocam).
create or replace function public.bot_set_gift_payer(p_checkout_id text, p_payer_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := nullif(btrim(regexp_replace(coalesce(p_payer_name, ''), '\s+', ' ', 'g')), '');
begin
  if v_name is null or nullif(btrim(p_checkout_id), '') is null then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  update public.gift_orders o
     set payer_name = left(v_name, 120), updated_at = now()
   where o.asaas_checkout_id = p_checkout_id
     and o.payer_name is null;
  return jsonb_build_object('ok', true, 'changed', found);
end;
$$;

-- Presentes pagos (e estornados) para o comando "presentes" dos organizadores.
create or replace function public.bot_gift_report()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'gift_name', o.gift_name,
           'kind', o.kind,
           'status', o.status,
           'payment_method', o.payment_method,
           'base_cents', o.base_cents,
           'payer_name', o.payer_name,
           'signature', o.signature,
           'anonymous', o.anonymous,
           'has_message', o.message is not null,
           'paid_at', o.paid_at)
         order by o.paid_at, o.id), '[]'::jsonb)
    from public.gift_orders o
   where o.status in ('paid', 'refunded')
$$;

revoke all on function public.bot_set_gift_payer(text, text) from public, anon, authenticated;
grant execute on function public.bot_set_gift_payer(text, text) to service_role;
revoke all on function public.bot_gift_report() from public, anon, authenticated;
grant execute on function public.bot_gift_report() to service_role;
