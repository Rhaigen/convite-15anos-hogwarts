/**
 * asaas-webhook: o Asaas avisa o resultado dos checkouts da lista de presentes.
 *
 *   POST { id, event, checkout: { id } } (ou payment.checkoutSession nos eventos de estorno)
 *
 * Autenticação: o token cadastrado no painel do Asaas chega no cabeçalho
 * `asaas-access-token` e é comparado em tempo constante com ASAAS_WEBHOOK_TOKEN.
 * Entrega "pelo menos uma vez": o banco registra o id do evento e ignora repetidos.
 * Eventos que não interessam também recebem 200 (a fila do Asaas pausa depois de
 * falhas seguidas); só erro do banco devolve 500, para o Asaas tentar de novo.
 *
 * Quem pagou: no CHECKOUT_PAID (e nos avisos de pagamento, se estiverem ligados no painel),
 * a função busca o nome do cliente na API do Asaas e grava no pedido, só para o comando
 * "presentes" dos organizadores. É o melhor esforço: falhar aqui não desfaz o pagamento.
 */
import type { Rpc } from '../repo.ts';
import { normalizeAsaasApiUrl, normalizeText } from './checkout.ts';

type Logger = (event: string, data?: Record<string, unknown>) => void;

const BODY_MAX = 256 * 1024;
export const HANDLED_EVENTS = ['CHECKOUT_PAID', 'CHECKOUT_CANCELED', 'CHECKOUT_EXPIRED', 'PAYMENT_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED'];
/** Avisos de pagamento: não mudam o status (quem manda é o CHECKOUT_*), só trazem o cliente. */
export const PAYER_EVENTS = ['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'];
const PAYER_NAME_MAX = 120;
const CUSTOMER_ID = /^cus_[A-Za-z0-9]{1,60}$/;

export interface AsaasWebhookDeps {
  rpc: Rpc;
  /** ASAAS_WEBHOOK_TOKEN (o mesmo cadastrado no painel do Asaas; pelo menos 32 caracteres). */
  token: string;
  /** ASAAS_API_URL e ASAAS_API_KEY, para buscar o nome de quem pagou (sem eles, não busca). */
  asaas?: { apiUrl: string; apiKey: string };
  fetch?: typeof fetch;
  timeoutMs?: number;
  log?: Logger;
}

/** De onde sai o pagador do evento: o nome direto (customerData) ou o código do cliente (cus_…). */
export function payerOf(body: Record<string, unknown>): { name: string } | { customerId: string } | null {
  const checkout = (body.checkout ?? {}) as { customer?: unknown; customerData?: { name?: unknown } | null };
  const payment = (body.payment ?? {}) as { customer?: unknown };
  const name = typeof checkout.customerData?.name === 'string' ? normalizeText(checkout.customerData.name, 500, false) : null;
  if (name) return { name: name.slice(0, PAYER_NAME_MAX) };
  const id = checkout.customer ?? payment.customer;
  return typeof id === 'string' && CUSTOMER_ID.test(id) ? { customerId: id } : null;
}

/** Comparação em tempo constante (não revela onde os textos diferem). */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/** Id do checkout a que o evento se refere. */
export function checkoutIdOf(body: Record<string, unknown>): string | null {
  const checkout = body.checkout as { id?: unknown } | undefined;
  const payment = body.payment as { checkoutSession?: unknown } | undefined;
  const id = checkout?.id ?? payment?.checkoutSession;
  return typeof id === 'string' && id.length > 0 && id.length <= 100 ? id : null;
}

export function createAsaasWebhookHandler(deps: AsaasWebhookDeps): (req: Request) => Promise<Response> {
  const log = deps.log ?? (() => {});
  const doFetch = deps.fetch ?? fetch;
  const apiUrl = normalizeAsaasApiUrl(deps.asaas?.apiUrl);
  const apiKey = deps.asaas?.apiKey ?? '';

  const asaasGet = async (path: string): Promise<unknown> => {
    const res = await doFetch(`${apiUrl}${path}`, {
      headers: { Accept: 'application/json', access_token: apiKey, 'User-Agent': 'convite-sofia-15anos' },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 8_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  /** Nome do cliente no Asaas (GET /v3/customers/{id}); null se não houver. */
  async function customerName(customerId: string): Promise<string | null> {
    const data = (await asaasGet(`/v3/customers/${encodeURIComponent(customerId)}`)) as { name?: unknown };
    const name = typeof data.name === 'string' ? normalizeText(data.name, 500, false) : null;
    return name ? name.slice(0, PAYER_NAME_MAX) : null;
  }

  /**
   * Cliente da cobrança gerada pelo checkout (GET /v3/payments?checkoutSession=…). O aviso
   * CHECKOUT_PAID vem com `customer` vazio: o cliente só nasce quando o convidado paga.
   */
  async function customerOfCheckout(checkoutId: string): Promise<string | null> {
    const data = (await asaasGet(`/v3/payments?checkoutSession=${encodeURIComponent(checkoutId)}&limit=1`)) as { data?: { customer?: unknown }[] };
    const id = data.data?.[0]?.customer;
    return typeof id === 'string' && CUSTOMER_ID.test(id) ? id : null;
  }

  /** Grava quem pagou no pedido do checkout. Nunca lança (o pagamento já está registrado). */
  async function recordPayer(asaasEvent: string, body: Record<string, unknown>, checkoutId: string | null): Promise<void> {
    if (!checkoutId) return;
    if (!apiUrl || !apiKey) {
      log('gift_payer_missing', { asaasEvent, reason: 'no_api' });
      return;
    }
    try {
      const payer = payerOf(body);
      const source = payer && 'name' in payer ? 'customerData' : payer ? 'customer' : 'payments';
      let name = payer && 'name' in payer ? payer.name : null;
      if (!name) {
        const customerId = payer && 'customerId' in payer ? payer.customerId : await customerOfCheckout(checkoutId);
        name = customerId ? await customerName(customerId) : null;
      }
      if (!name) {
        log('gift_payer_missing', { asaasEvent, source });
        return;
      }
      const result = (await deps.rpc('bot_set_gift_payer', { p_checkout_id: checkoutId, p_payer_name: name })) as { ok: boolean; changed?: boolean };
      log('gift_payer_recorded', { asaasEvent, source, changed: result.changed });
    } catch (error) {
      log('gift_payer_failed', { asaasEvent, error: String(error).slice(0, 200) });
    }
  }
  const json = (status: number, body: Record<string, unknown>) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

  return async (req) => {
    if (req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    if (deps.token.length < 32) {
      log('webhook_token_missing');
      return json(503, { error: 'unavailable' });
    }
    if (!safeEqual(req.headers.get('asaas-access-token') ?? '', deps.token)) {
      log('webhook_unauthorized');
      return json(401, { error: 'unauthorized' });
    }

    let body: Record<string, unknown>;
    try {
      const text = await req.text();
      if (text.length > BODY_MAX) return json(413, { error: 'too_large' });
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return json(400, { error: 'invalid' });
      body = parsed as Record<string, unknown>;
    } catch {
      return json(400, { error: 'invalid' });
    }

    const event = typeof body.event === 'string' ? body.event : '';
    const eventId = typeof body.id === 'string' ? body.id : '';
    if (PAYER_EVENTS.includes(event)) {
      await recordPayer(event, body, checkoutIdOf(body));
      return json(200, { received: true });
    }
    if (!HANDLED_EVENTS.includes(event)) {
      log('webhook_ignored', { event: event.slice(0, 60) });
      return json(200, { received: true });
    }

    try {
      const result = (await deps.rpc('bot_apply_gift_event', {
        p_event_id: eventId,
        p_event: event,
        p_checkout_id: checkoutIdOf(body),
      })) as { ok: boolean; error?: string; status?: string; changed?: boolean; duplicate?: boolean };
      log('webhook_applied', { event, ok: result.ok, error: result.error, status: result.status, changed: result.changed, duplicate: result.duplicate });
      if (event === 'CHECKOUT_PAID' && result.ok && !result.duplicate) await recordPayer(event, body, checkoutIdOf(body));
    } catch (error) {
      log('webhook_failed', { event, error: String(error) });
      return json(500, { error: 'retry' });
    }
    return json(200, { received: true });
  };
}
