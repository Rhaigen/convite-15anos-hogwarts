/**
 * Lista de presentes no servidor, sobre o banco real (PGlite com as migrações):
 * gift-checkout (preço do servidor, origem, limites, Asaas falso), asaas-webhook
 * (token, idempotência, transições), site-gifts (só pagos) e a segurança das tabelas.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GiftCatalog } from '../supabase/functions/_shared/gifts/catalogTypes.ts';
import {
  asaasCheckoutBody,
  createGiftCheckoutHandler,
  fetchGiftPhoto,
  isAsaasCheckoutUrl,
  normalizeAsaasApiUrl,
  normalizeSiteUrl,
  normalizeText,
  parseCheckoutRequest,
  toBase64,
  type GiftCheckoutDeps,
} from '../supabase/functions/_shared/gifts/checkout.ts';
import { chargedCents } from '../supabase/functions/_shared/gifts/pricing.ts';
import { createSiteGiftsHandler, toProgress } from '../supabase/functions/_shared/gifts/progress.ts';
import { checkoutIdOf, createAsaasWebhookHandler, safeEqual } from '../supabase/functions/_shared/gifts/webhook.ts';
import { createTestDb, type TestDb } from './support/agent.ts';

const SITE = 'https://convite.example';
const TOKEN = 'token-do-webhook-com-mais-de-32-caracteres';
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CATALOG: GiftCatalog = {
  maxInstallments: 6,
  fees: {
    pixFixedCents: 199,
    cardFixedCents: 49,
    card: [
      { upTo: 1, basisPoints: 299 },
      { upTo: 6, basisPoints: 349 },
    ],
  },
  fundMinCents: 2_000,
  fundMaxCents: 500_000,
  gifts: [
    { id: 'varinha', kind: 'quota', name: 'Uma varinha nova', checkoutName: 'Uma varinha nova', checkoutDescription: 'Para os feitiços', amountCents: 15_000 },
    { id: 'viagem', kind: 'fund', name: 'A viagem', checkoutName: 'A viagem', checkoutDescription: 'Presente', goalCents: 500_000 },
  ],
};

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});

beforeEach(async () => {
  await t.db.exec('truncate public.gift_orders, public.gift_webhook_events');
});

interface AsaasCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

let checkoutSeq = 0;

/** Asaas falso: registra as chamadas e responde como mandado (ids de checkout únicos no arquivo). */
function fakeAsaas(respond: (n: number) => Response | Error = (n) => Response.json({ id: `chk_${n}`, link: `https://sandbox.asaas.com/checkoutSession/show?id=chk_${n}` })) {
  const calls: AsaasCall[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    const out = respond(++checkoutSeq);
    if (out instanceof Error) throw out;
    return out;
  }) as typeof fetch;
  return { calls, fetchFn };
}

function checkoutHandler(overrides: Partial<GiftCheckoutDeps> = {}) {
  const asaas = fakeAsaas();
  const logs: { event: string; data?: Record<string, unknown> }[] = [];
  const handler = createGiftCheckoutHandler({
    rpc: t.rpc,
    allowedOrigins: [SITE],
    catalog: CATALOG,
    imageBase64: '/9j/AAAA',
    asaas: { apiUrl: 'https://api-sandbox.asaas.com', apiKey: '$aact_teste_chave' },
    siteUrl: SITE,
    ipSalt: 'sal-secreto-de-teste-1234',
    fetch: asaas.fetchFn,
    log: (event, data) => logs.push({ event, data }),
    ...overrides,
  });
  return { handler, calls: asaas.calls, logs };
}

/** POST do site; sem a chave `method`, vai como cartão (para testar a falta dela: `method: undefined`). */
const post = (body: unknown, { origin = SITE as string | null, ip = '200.1.2.3', type = 'application/json' } = {}) =>
  new Request('https://fn.test/gift-checkout', {
    method: 'POST',
    headers: { ...(origin ? { Origin: origin } : {}), 'Content-Type': type, 'X-Forwarded-For': `${ip}, 10.0.0.1` },
    body: typeof body === 'string' ? body : JSON.stringify(body && typeof body === 'object' && !('method' in body) ? { method: 'card', ...body } : body),
  });

const orders = async () =>
  (
    await t.db.query<{ gift_id: string; status: string; payment_method: string | null; base_cents: number; charged_cents: number; message: string | null; signature: string | null; anonymous: boolean; asaas_checkout_id: string | null; ip_hash: string | null }>(
      'select * from public.gift_orders order by created_at, id',
    )
  ).rows;

describe('gift-checkout', () => {
  it('cota no cartão: preço do servidor, pedido gravado e link do Asaas devolvido', async () => {
    const { handler, calls } = checkoutHandler();
    const res = await handler(post({ giftId: 'varinha', message: '  Parabéns,\n\n\n\nSofia!  ', signature: ' Tio  Carlos ', anonymous: false }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(SITE);
    const { url } = (await res.json()) as { url: string };
    const checkoutId = /^https:\/\/sandbox\.asaas\.com\/checkoutSession\/show\?id=(chk_\d+)$/.exec(url)?.[1];
    expect(checkoutId).toBeTruthy();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api-sandbox.asaas.com/v3/checkouts');
    expect(calls[0]!.headers.access_token).toBe('$aact_teste_chave');
    const [row] = await orders();
    expect(row).toMatchObject({
      gift_id: 'varinha',
      status: 'pending',
      payment_method: 'card',
      base_cents: 15_000,
      charged_cents: 15_594,
      message: 'Parabéns,\n\nSofia!',
      signature: 'Tio Carlos',
      anonymous: false,
      asaas_checkout_id: checkoutId,
    });
    expect(row!.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.ip_hash).not.toContain('200.1.2.3');
    expect(calls[0]!.body).toMatchObject({
      billingTypes: ['CREDIT_CARD'],
      chargeTypes: ['DETACHED', 'INSTALLMENT'],
      installment: { maxInstallmentCount: 6 },
      minutesToExpire: 60,
      callback: { successUrl: `${SITE}/?presente=enviado`, cancelUrl: `${SITE}/?presente=cancelado`, expiredUrl: `${SITE}/?presente=expirado` },
      items: [{ name: 'Uma varinha nova', description: 'Para os feitiços', quantity: 1, value: 155.94, imageBase64: '/9j/AAAA', externalReference: 'varinha' }],
    });
    // A mensagem não vai para o Asaas.
    expect(JSON.stringify(calls[0]!.body)).not.toMatch(/Parabéns|Carlos/);
  });

  it('cota no Pix: checkout só com Pix, sem parcelas, e a família recebe exatamente a base', async () => {
    const { handler, calls, logs } = checkoutHandler();
    expect((await handler(post({ giftId: 'varinha', method: 'pix' }))).status).toBe(200);
    expect(calls[0]!.body).toMatchObject({ billingTypes: ['PIX'], chargeTypes: ['DETACHED'], items: [{ value: 151.99 }] });
    expect(calls[0]!.body).not.toHaveProperty('installment');
    expect(await orders()).toMatchObject([{ payment_method: 'pix', base_cents: 15_000, charged_cents: 15_199 }]);
    expect(logs.at(-1)).toEqual({ event: 'gift_checkout_created', data: { gift: 'varinha', kind: 'quota', method: 'pix' } });
  });

  it('forma de pagamento obrigatória e só pix ou card', async () => {
    const { handler, calls } = checkoutHandler();
    for (const method of [undefined, null, '', 'PIX', 'boleto', 1, ['pix']]) {
      expect((await handler(post({ giftId: 'varinha', method }))).status).toBe(400);
    }
    expect(calls).toHaveLength(0);
    expect(await orders()).toHaveLength(0);
  });

  it('vaquinha: valor do convidado dentro dos limites; preço sempre recalculado', async () => {
    const { handler, calls } = checkoutHandler();
    expect((await handler(post({ giftId: 'viagem', amountCents: 10_000 }))).status).toBe(200);
    expect((calls[0]!.body.items as { value: number }[])[0]!.value).toBe(chargedCents(10_000, 'card', CATALOG.fees, 6) / 100);
    for (const amountCents of [1_999, 500_001, 100.5, '10000', undefined]) {
      expect((await handler(post({ giftId: 'viagem', amountCents }))).status).toBe(400);
    }
    // Cota não aceita valor vindo do navegador, nem campo desconhecido (ex.: um "preço").
    expect((await handler(post({ giftId: 'varinha', amountCents: 100 }))).status).toBe(400);
    expect((await handler(post({ giftId: 'varinha', price: 1 }))).status).toBe(400);
    expect((await handler(post({ giftId: 'nao-existe' }))).status).toBe(400);
    expect(calls).toHaveLength(1);
    expect(await orders()).toHaveLength(1);
  });

  it('mensagem: assinada, em segredo ou sem assinatura (recusada)', async () => {
    const { handler } = checkoutHandler();
    expect((await handler(post({ giftId: 'varinha', message: 'Oi', anonymous: true, signature: 'Ignorada' }))).status).toBe(200);
    const res = await handler(post({ giftId: 'varinha', message: 'Oi' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'signature_required' });
    expect((await handler(post({ giftId: 'varinha', signature: 'Sem mensagem' }))).status).toBe(200);
    expect((await handler(post({ giftId: 'varinha', message: 'x'.repeat(501), anonymous: true }))).status).toBe(400);
    const rows = await orders();
    expect(rows.map((r) => [r.message, r.signature, r.anonymous])).toEqual([
      ['Oi', null, true],
      [null, null, false],
    ]);
  });

  it('recusa outra origem, outro método, outro tipo, corpo grande e robôs', async () => {
    const { handler, calls } = checkoutHandler();
    expect((await handler(post({ giftId: 'varinha' }, { origin: 'https://outro.example' }))).status).toBe(403);
    expect((await handler(post({ giftId: 'varinha' }, { origin: null }))).status).toBe(403);
    expect((await handler(post({ giftId: 'varinha' }, { type: 'text/plain' }))).status).toBe(415);
    expect((await handler(post('{"giftId":'))).status).toBe(400);
    expect((await handler(post({ giftId: 'varinha', message: 'x'.repeat(5000) }))).status).toBe(413);
    expect((await handler(post({ giftId: 'varinha', website: 'http://spam' }))).status).toBe(400);
    expect((await handler(new Request('https://fn.test/gift-checkout', { method: 'GET', headers: { Origin: SITE } }))).status).toBe(405);
    const pre = await handler(new Request('https://fn.test/gift-checkout', { method: 'OPTIONS', headers: { Origin: SITE } }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
    expect(pre.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
    expect(calls).toHaveLength(0);
    expect(await orders()).toHaveLength(0);
  });

  it('limita 5 pedidos por IP em 10 minutos (429); outro IP continua', async () => {
    const { handler } = checkoutHandler();
    for (let i = 0; i < 5; i++) expect((await handler(post({ giftId: 'varinha' }))).status).toBe(200);
    const res = await handler(post({ giftId: 'varinha' }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'busy' });
    expect((await handler(post({ giftId: 'varinha' }, { ip: '200.9.9.9' }))).status).toBe(200);
  });

  it('Asaas fora do ar, com erro ou link estranho: 503 genérico e o pedido (com a mensagem) é descartado', async () => {
    const cases: (Response | Error)[] = [
      new Error('connect ECONNREFUSED'),
      Response.json({ errors: [{ code: 'invalid_value', description: 'detalhe' }] }, { status: 400 }),
      Response.json({ id: 'chk_x', link: 'https://asaas.com.golpe.example/pagar' }),
      Response.json({ link: 'https://asaas.com/checkoutSession/show?id=x' }),
    ];
    for (const out of cases) {
      const asaas = fakeAsaas(() => out);
      const logs: string[] = [];
      const { handler } = checkoutHandler({ fetch: asaas.fetchFn, log: (e) => logs.push(e) });
      const res = await handler(post({ giftId: 'varinha', message: 'Segredo', anonymous: true }));
      expect(res.status).toBe(503);
      expect(await res.text()).toBe('{"error":"unavailable"}');
      expect(logs).toContain('asaas_checkout_failed');
    }
    expect(await orders()).toHaveLength(0);
  });

  it('sem link na resposta, monta o endereço oficial do checkout', async () => {
    const asaas = fakeAsaas(() => Response.json({ id: 'chk_9' }));
    const { handler } = checkoutHandler({ fetch: asaas.fetchFn });
    expect(await (await handler(post({ giftId: 'varinha' }))).json()).toEqual({ url: 'https://sandbox.asaas.com/checkoutSession/show?id=chk_9' });
  });

  it('foto do presente: PNG buscado no convite e guardado; presente sem foto ou foto inválida leva o brasão', async () => {
    const png = Uint8Array.from([...PNG_SIGNATURE, 1, 2, 3]);
    const catalog: GiftCatalog = { ...CATALOG, gifts: CATALOG.gifts.map((g) => (g.id === 'varinha' ? { ...g, photo: '/presentes/varinha.png' } : g)) };
    const asaas = fakeAsaas();
    const photoCalls: string[] = [];
    let photo = () => new Response(png, { headers: { 'Content-Type': 'image/png' } });
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).startsWith(SITE)) return asaas.fetchFn(url, init);
      photoCalls.push(String(url));
      return photo();
    }) as typeof fetch;
    const image = (n: number) => (asaas.calls[n]!.body.items as { imageBase64: string }[])[0]!.imageBase64;

    const first = checkoutHandler({ catalog, fetch: fetchFn });
    expect((await first.handler(post({ giftId: 'varinha' }))).status).toBe(200);
    expect(photoCalls).toEqual([`${SITE}/presentes/varinha.png`]);
    expect(image(0)).toBe(Buffer.from(png).toString('base64'));
    expect((await first.handler(post({ giftId: 'varinha' }))).status).toBe(200);
    expect(photoCalls).toHaveLength(1);
    expect(image(1)).toBe(Buffer.from(png).toString('base64'));
    expect((await first.handler(post({ giftId: 'viagem', amountCents: 10_000 }))).status).toBe(200);
    expect(photoCalls).toHaveLength(1);
    expect(image(2)).toBe('/9j/AAAA');

    // O convite sem a foto (não publicada) não impede o presente.
    photo = () => new Response('não encontrado', { status: 404 });
    const second = checkoutHandler({ catalog, fetch: fetchFn });
    expect((await second.handler(post({ giftId: 'varinha' }, { ip: '200.9.9.9' }))).status).toBe(200);
    expect(image(3)).toBe('/9j/AAAA');
    expect(second.logs.map((l) => l.event)).toContain('gift_photo_unavailable');
  });

  it('sem configuração completa não chama o Asaas (503)', async () => {
    for (const overrides of [
      { siteUrl: '' },
      { siteUrl: 'http://convite.example' },
      { asaas: { apiUrl: 'https://api.golpe.example', apiKey: 'x' } },
      { asaas: { apiUrl: 'https://api.asaas.com', apiKey: '' } },
      { ipSalt: 'curto' },
    ]) {
      const { handler, calls } = checkoutHandler(overrides);
      expect((await handler(post({ giftId: 'varinha' }))).status).toBe(503);
      expect(calls).toHaveLength(0);
    }
  });
});

describe('asaas-webhook', () => {
  const hook = (body: unknown, token: string | null = TOKEN) =>
    new Request('https://fn.test/asaas-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'asaas-access-token': token } : {}) },
      body: JSON.stringify(body),
    });

  async function createOrder(body: Record<string, unknown>) {
    const { handler } = checkoutHandler();
    await handler(post(body));
    return (await orders()).at(-1)!.asaas_checkout_id!;
  }

  it('token errado ou ausente: 401, nada muda', async () => {
    const id = await createOrder({ giftId: 'varinha' });
    const handler = createAsaasWebhookHandler({ rpc: t.rpc, token: TOKEN });
    expect((await handler(hook({ id: 'evt_1', event: 'CHECKOUT_PAID', checkout: { id } }, 'outro-token'))).status).toBe(401);
    expect((await handler(hook({ id: 'evt_1', event: 'CHECKOUT_PAID', checkout: { id } }, null))).status).toBe(401);
    expect((await orders())[0]!.status).toBe('pending');
    // Sem token configurado, recusa tudo.
    expect((await createAsaasWebhookHandler({ rpc: t.rpc, token: '' })(hook({}, ''))).status).toBe(503);
  });

  it('pago → conta na vaquinha e o recado vai para o livro; evento repetido é ignorado', async () => {
    const id = await createOrder({ giftId: 'viagem', amountCents: 25_000, message: 'Boa viagem!', signature: 'Vovó Lúcia' });
    const handler = createAsaasWebhookHandler({ rpc: t.rpc, token: TOKEN });
    const paid = { id: 'evt_pago', event: 'CHECKOUT_PAID', checkout: { id, status: 'PAID' } };
    expect((await handler(hook(paid))).status).toBe(200);
    expect((await handler(hook(paid))).status).toBe(200);
    // Atrasado: "expirado" não desfaz o pagamento.
    await handler(hook({ id: 'evt_exp', event: 'CHECKOUT_EXPIRED', checkout: { id } }));
    expect((await orders())[0]!.status).toBe('paid');

    expect(await t.rpc('bot_gift_progress', {})).toEqual([{ gift_id: 'viagem', raised_cents: 25_000 }]);
    expect(await t.rpc('bot_gift_messages', {})).toEqual([
      { gift_name: 'A viagem', signature: 'Vovó Lúcia', anonymous: false, body: 'Boa viagem!', paid_at: expect.any(String) },
    ]);
    const events = await t.db.query('select * from public.gift_webhook_events');
    expect(events.rows).toHaveLength(2);
  });

  it('cancelado e expirado não contam; Pix pago depois do "expirado" conta; estorno tira da conta', async () => {
    const a = await createOrder({ giftId: 'viagem', amountCents: 5_000, message: 'Nunca pago', anonymous: true });
    const b = await createOrder({ giftId: 'viagem', amountCents: 7_000 });
    const handler = createAsaasWebhookHandler({ rpc: t.rpc, token: TOKEN });
    await handler(hook({ id: 'e1', event: 'CHECKOUT_CANCELED', checkout: { id: a } }));
    await handler(hook({ id: 'e2', event: 'CHECKOUT_EXPIRED', checkout: { id: b } }));
    expect(await t.rpc('bot_gift_progress', {})).toEqual([]);
    expect(await t.rpc('bot_gift_messages', {})).toEqual([]);

    await handler(hook({ id: 'e3', event: 'CHECKOUT_PAID', checkout: { id: b } }));
    expect(await t.rpc('bot_gift_progress', {})).toEqual([{ gift_id: 'viagem', raised_cents: 7_000 }]);
    await handler(hook({ id: 'e4', event: 'PAYMENT_REFUNDED', payment: { id: 'pay_1', checkoutSession: b } }));
    expect(await t.rpc('bot_gift_progress', {})).toEqual([]);
    expect((await orders()).map((o) => o.status)).toEqual(['canceled', 'refunded']);
  });

  it('eventos que não interessam e checkout desconhecido recebem 200 (a fila do Asaas não pausa)', async () => {
    const logs: { event: string; data?: Record<string, unknown> }[] = [];
    const handler = createAsaasWebhookHandler({ rpc: t.rpc, token: TOKEN, log: (event, data) => logs.push({ event, data }) });
    expect((await handler(hook({ id: 'x1', event: 'PAYMENT_CREATED', payment: {} }))).status).toBe(200);
    expect((await handler(hook({ id: 'x2', event: 'CHECKOUT_PAID', checkout: { id: 'chk_desconhecido' } }))).status).toBe(200);
    expect(logs.map((l) => l.event)).toEqual(['webhook_ignored', 'webhook_applied']);
    expect(logs[1]!.data).toMatchObject({ ok: false, error: 'not_found' });
  });

  it('erro do banco: 500 para o Asaas tentar de novo', async () => {
    const handler = createAsaasWebhookHandler({
      rpc: async () => {
        throw new Error('db down');
      },
      token: TOKEN,
    });
    expect((await handler(hook({ id: 'x', event: 'CHECKOUT_PAID', checkout: { id: 'c' } }))).status).toBe(500);
  });

  describe('quem pagou (só para os organizadores)', () => {
    /** API do Asaas falsa: GET /v3/payments?checkoutSession=… (cobrança do checkout) e GET /v3/customers/{id}. */
    const asaasDefault = (url: string) =>
      url.includes('/v3/payments?')
        ? Response.json({ object: 'list', data: [{ id: 'pay_1', customer: 'cus_1', checkoutSession: 'x' }] })
        : Response.json({ id: 'cus_1', name: '  Maria   Souza ' });
    function customersApi(respond: (url: string) => Response | Error = asaasDefault) {
      const calls: { url: string; headers: Record<string, string> }[] = [];
      const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), headers: init?.headers as Record<string, string> });
        const out = respond(String(url));
        if (out instanceof Error) throw out;
        return out;
      }) as typeof fetch;
      return { calls, fetchFn };
    }
    const payerHandler = (api = customersApi(), logs: string[] = []) =>
      createAsaasWebhookHandler({
        rpc: t.rpc,
        token: TOKEN,
        asaas: { apiUrl: 'https://api-sandbox.asaas.com', apiKey: '$aact_teste_chave' },
        fetch: api.fetchFn,
        log: (e) => logs.push(e),
      });
    const payers = async () => (await t.db.query<{ status: string; payer_name: string | null }>('select status, payer_name from public.gift_orders order by created_at, id')).rows;

    it('CHECKOUT_PAID como o Asaas manda (cliente vazio): acha a cobrança do checkout, o cliente e o nome', async () => {
      const id = await createOrder({ giftId: 'varinha', method: 'card' });
      const api = customersApi();
      const logs: string[] = [];
      const handler = payerHandler(api, logs);
      const paid = { id: 'evt_real', event: 'CHECKOUT_PAID', checkout: { id, status: 'PAID', customer: null, customerData: null } };
      expect((await handler(hook(paid))).status).toBe(200);
      expect(api.calls.map((c) => c.url)).toEqual([
        `https://api-sandbox.asaas.com/v3/payments?checkoutSession=${id}&limit=1`,
        'https://api-sandbox.asaas.com/v3/customers/cus_1',
      ]);
      expect(await payers()).toEqual([{ status: 'paid', payer_name: 'Maria Souza' }]);
      expect(logs).toContain('gift_payer_recorded');
    });

    it('cobrança ainda sem cliente: fica sem nome, sem erro', async () => {
      const id = await createOrder({ giftId: 'varinha' });
      const logs: string[] = [];
      const handler = payerHandler(customersApi(() => Response.json({ object: 'list', data: [] })), logs);
      expect((await handler(hook({ id: 'e0', event: 'CHECKOUT_PAID', checkout: { id, customer: null } }))).status).toBe(200);
      expect(await payers()).toEqual([{ status: 'paid', payer_name: null }]);
      expect(logs).toContain('gift_payer_missing');
    });

    it('CHECKOUT_PAID com o código do cliente: busca o nome no Asaas e grava; repetido não busca de novo', async () => {
      const id = await createOrder({ giftId: 'varinha', method: 'pix' });
      const api = customersApi();
      const handler = payerHandler(api);
      const paid = { id: 'evt_p1', event: 'CHECKOUT_PAID', checkout: { id, status: 'PAID', customer: 'cus_1' } };
      expect((await handler(hook(paid))).status).toBe(200);
      expect((await handler(hook(paid))).status).toBe(200);
      expect(api.calls).toHaveLength(1);
      expect(api.calls[0]!.url).toBe('https://api-sandbox.asaas.com/v3/customers/cus_1');
      expect(api.calls[0]!.headers.access_token).toBe('$aact_teste_chave');
      expect(await payers()).toEqual([{ status: 'paid', payer_name: 'Maria Souza' }]);
    });

    it('nome direto no aviso (customerData) dispensa a API; código de cliente estranho nunca vai para a URL', async () => {
      const a = await createOrder({ giftId: 'varinha' });
      const b = await createOrder({ giftId: 'varinha' });
      const api = customersApi();
      const handler = payerHandler(api);
      await handler(hook({ id: 'e1', event: 'CHECKOUT_PAID', checkout: { id: a, customer: 'cus_9', customerData: { name: 'João Lima' } } }));
      expect(api.calls).toHaveLength(0);
      await handler(hook({ id: 'e2', event: 'CHECKOUT_PAID', checkout: { id: b, customer: '../segredo' } }));
      expect(api.calls.some((c) => c.url.includes('segredo'))).toBe(false);
      expect(await payers()).toEqual([
        { status: 'paid', payer_name: 'João Lima' },
        { status: 'paid', payer_name: 'Maria Souza' },
      ]);
    });

    it('aviso de pagamento (PAYMENT_RECEIVED) só traz o nome: não muda o status', async () => {
      const id = await createOrder({ giftId: 'varinha' });
      const handler = payerHandler();
      const res = await handler(hook({ id: 'e3', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_1', customer: 'cus_1', checkoutSession: id } }));
      expect(res.status).toBe(200);
      expect(await payers()).toEqual([{ status: 'pending', payer_name: 'Maria Souza' }]);
    });

    it('Asaas fora do ar ao buscar o nome: o pagamento continua registrado (200), só sem o nome', async () => {
      const id = await createOrder({ giftId: 'varinha' });
      const logs: string[] = [];
      const handler = payerHandler(customersApi(() => new Error('timeout')), logs);
      expect((await handler(hook({ id: 'e4', event: 'CHECKOUT_PAID', checkout: { id, customer: 'cus_1' } }))).status).toBe(200);
      expect(await payers()).toEqual([{ status: 'paid', payer_name: null }]);
      expect(logs).toContain('gift_payer_failed');
    });

    it('o nome não sai pelo progresso, pelo livro nem pelo site-gifts; só pelo bot_gift_report', async () => {
      const id = await createOrder({ giftId: 'viagem', amountCents: 5_000, message: 'Boa viagem!', anonymous: true });
      await payerHandler()(hook({ id: 'e5', event: 'CHECKOUT_PAID', checkout: { id, customer: 'cus_1' } }));
      const site = createSiteGiftsHandler({ rpc: t.rpc, allowedOrigins: [SITE], catalog: CATALOG });
      for (const out of [
        await t.rpc('bot_gift_progress', {}),
        await t.rpc('bot_gift_messages', {}),
        await (await site(new Request('https://fn.test/site-gifts'))).json(),
      ]) {
        expect(JSON.stringify(out)).not.toContain('Maria');
      }
      expect(await t.rpc('bot_gift_report', {})).toEqual([
        {
          gift_name: 'A viagem',
          kind: 'fund',
          status: 'paid',
          payment_method: 'card',
          base_cents: 5_000,
          payer_name: 'Maria Souza',
          signature: null,
          anonymous: true,
          has_message: true,
          paid_at: expect.any(String),
        },
      ]);
    });
  });
});

describe('site-gifts', () => {
  it('soma só os pagos; metas do catálogo; CORS do convite', async () => {
    await t.rpc('bot_create_gift_order', {
      p_gift_id: 'viagem', p_gift_name: 'A viagem', p_kind: 'fund', p_payment_method: 'pix', p_base_cents: 30_000, p_charged_cents: 31_000,
      p_message: null, p_signature: null, p_anonymous: false, p_ip_hash: null,
    });
    await t.db.exec(`update public.gift_orders set status = 'paid', asaas_checkout_id = 'c1'`);
    await t.rpc('bot_create_gift_order', {
      p_gift_id: 'viagem', p_gift_name: 'A viagem', p_kind: 'fund', p_payment_method: 'pix', p_base_cents: 99_000, p_charged_cents: 99_999,
      p_message: null, p_signature: null, p_anonymous: false, p_ip_hash: null,
    });
    const handler = createSiteGiftsHandler({ rpc: t.rpc, allowedOrigins: [SITE], catalog: CATALOG });
    const res = await handler(new Request('https://fn.test/site-gifts', { headers: { Origin: SITE } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(SITE);
    expect(await res.json()).toEqual({ gifts: [{ id: 'viagem', raisedCents: 30_000, goalCents: 500_000 }] });
    expect((await handler(new Request('https://fn.test/site-gifts', { method: 'POST' }))).status).toBe(405);
  });

  it('sem vaquinhas no catálogo nem consulta o banco; erro vira 503 genérico', async () => {
    let calls = 0;
    const rpc = async () => {
      calls++;
      throw new Error('relation "segredo" does not exist');
    };
    const empty = createSiteGiftsHandler({ rpc, allowedOrigins: [SITE], catalog: { ...CATALOG, gifts: [] } });
    expect(await (await empty(new Request('https://fn.test/site-gifts'))).json()).toEqual({ gifts: [] });
    expect(calls).toBe(0);
    const failing = createSiteGiftsHandler({ rpc, allowedOrigins: [SITE], catalog: CATALOG });
    const res = await failing(new Request('https://fn.test/site-gifts'));
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('{"error":"unavailable"}');
  });

  it('toProgress descarta lixo e preenche as vaquinhas sem pagamento', () => {
    expect(toProgress([{ gift_id: 'viagem', raised_cents: '1500' }, { gift_id: 1 }, null], CATALOG)).toEqual([
      { id: 'viagem', raisedCents: 1_500, goalCents: 500_000 },
    ]);
    expect(toProgress(null, CATALOG)).toEqual([{ id: 'viagem', raisedCents: 0, goalCents: 500_000 }]);
  });
});

describe('banco: segurança e limpeza', () => {
  it('anon e authenticated não leem as tabelas nem chamam as funções', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const sql of [
        'select * from public.gift_orders',
        'select * from public.gift_webhook_events',
        'select public.bot_gift_messages()',
        'select public.bot_gift_progress()',
        `select public.bot_apply_gift_event('e', 'CHECKOUT_PAID', 'c')`,
        `select public.bot_create_gift_order('a', 'A', 'quota', 'card', 100, 300, null, null, false, null)`,
        `select public.bot_set_gift_payer('c', 'Maria')`,
        'select public.bot_gift_report()',
      ]) {
        await expect(
          t.db.transaction(async (tx) => {
            await tx.exec(`set local role ${role}`);
            await tx.query(sql);
          }),
        ).rejects.toThrow(/permission denied/);
      }
    }
  });

  it('pedidos não pagos somem em 48 h (com a mensagem); o hash do IP some em 24 h; pagos ficam', async () => {
    const create = (message: string | null) =>
      t.rpc('bot_create_gift_order', {
        p_gift_id: 'varinha', p_gift_name: 'Varinha', p_kind: 'quota', p_payment_method: 'card', p_base_cents: 15_000, p_charged_cents: 15_594,
        p_message: message, p_signature: null, p_anonymous: message !== null, p_ip_hash: 'a'.repeat(64),
      });
    await create('Esquecido');
    await create('Pago');
    await t.db.exec(`update public.gift_orders set status = 'paid' where message = 'Pago'`);
    await t.db.exec(`update public.gift_orders set created_at = now() - interval '3 days'`);
    await create(null);
    const rows = await orders();
    expect(rows.map((r) => [r.message, r.status, r.ip_hash === null])).toEqual([
      ['Pago', 'paid', true],
      [null, 'pending', false],
    ]);
  });

  it('o banco também recusa dados fora do formato', async () => {
    const base = { p_gift_id: 'varinha', p_gift_name: 'Varinha', p_kind: 'quota', p_payment_method: 'card', p_base_cents: 100, p_charged_cents: 300, p_message: null, p_signature: null, p_anonymous: false, p_ip_hash: null };
    expect(await t.rpc('bot_create_gift_order', { ...base, p_gift_id: 'Com Espaço' })).toEqual({ ok: false, error: 'invalid' });
    expect(await t.rpc('bot_create_gift_order', { ...base, p_charged_cents: 50 })).toEqual({ ok: false, error: 'invalid' });
    expect(await t.rpc('bot_create_gift_order', { ...base, p_kind: 'free' })).toEqual({ ok: false, error: 'invalid' });
    expect(await t.rpc('bot_create_gift_order', { ...base, p_payment_method: null })).toEqual({ ok: false, error: 'invalid' });
    expect(await t.rpc('bot_create_gift_order', { ...base, p_payment_method: 'boleto' })).toEqual({ ok: false, error: 'invalid' });
    expect(await t.rpc('bot_create_gift_order', { ...base, p_message: 'x'.repeat(501), p_anonymous: true })).toEqual({ ok: false, error: 'invalid' });
    expect(await t.rpc('bot_create_gift_order', { ...base, p_message: 'Oi' })).toEqual({ ok: false, error: 'signature_required' });
    expect(await orders()).toHaveLength(0);
  });
});

describe('funções puras do checkout', () => {
  it('normalizeText', () => {
    expect(normalizeText('  a\u0000b‮c  ', 10, false)).toBe('abc');
    expect(normalizeText('l1\r\n\r\n\r\nl2', 10, true)).toBe('l1\n\nl2');
    expect(normalizeText('   ', 10, true)).toBeNull();
    expect(normalizeText(42, 10, true)).toBeUndefined();
    expect(normalizeText('x'.repeat(11), 10, true)).toBeUndefined();
  });

  it('endereços: site, API do Asaas e link do checkout', () => {
    expect(normalizeSiteUrl('https://sofia15.example/')).toBe('https://sofia15.example');
    expect(normalizeSiteUrl('http://localhost:5173')).toBe('http://localhost:5173');
    expect(normalizeSiteUrl('https://a.example/caminho')).toBeNull();
    expect(normalizeAsaasApiUrl('https://api.asaas.com')).toBe('https://api.asaas.com');
    expect(normalizeAsaasApiUrl('https://api-sandbox.asaas.com/')).toBe('https://api-sandbox.asaas.com');
    expect(normalizeAsaasApiUrl('https://api.asaas.com/v3')).toBeNull();
    expect(normalizeAsaasApiUrl('http://api.asaas.com')).toBeNull();
    expect(isAsaasCheckoutUrl('https://asaas.com/checkoutSession/show?id=1')).toBe(true);
    expect(isAsaasCheckoutUrl('https://sandbox.asaas.com/c/1')).toBe(true);
    expect(isAsaasCheckoutUrl('https://asaas.com.evil.example/')).toBe(false);
    expect(isAsaasCheckoutUrl('https://user:pw@asaas.com/')).toBe(false);
    expect(isAsaasCheckoutUrl('javascript:alert(1)')).toBe(false);
  });

  it('safeEqual e checkoutIdOf', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(checkoutIdOf({ checkout: { id: 'c1' } })).toBe('c1');
    expect(checkoutIdOf({ payment: { checkoutSession: 'c2' } })).toBe('c2');
    expect(checkoutIdOf({ checkout: { id: 3 } })).toBeNull();
  });

  it('fetchGiftPhoto: só PNG pequeno de /presentes/ no convite; qualquer problema vira null', async () => {
    const png = Uint8Array.from([...PNG_SIGNATURE, 7]);
    const urls: string[] = [];
    const serve = (res: () => Response) =>
      (async (url: string | URL | Request) => {
        urls.push(String(url));
        return res();
      }) as typeof fetch;
    expect(await fetchGiftPhoto(SITE, '/presentes/a-1.png', serve(() => new Response(png)))).toBe(Buffer.from(png).toString('base64'));
    expect(await fetchGiftPhoto(SITE, '/presentes/a.png', serve(() => new Response('<html>')))).toBeNull();
    expect(await fetchGiftPhoto(SITE, '/presentes/a.png', serve(() => new Response(png, { status: 500 })))).toBeNull();
    expect(await fetchGiftPhoto(SITE, '/presentes/a.png', serve(() => new Response(new Uint8Array(150_001).fill(1).map((b, i) => PNG_SIGNATURE[i] ?? b))))).toBeNull();
    expect(
      await fetchGiftPhoto(SITE, '/presentes/a.png', (async () => {
        throw new Error('fora do ar');
      }) as typeof fetch),
    ).toBeNull();
    expect(urls).toEqual([1, 2, 3, 4].map((n) => `${SITE}/presentes/${n === 1 ? 'a-1' : 'a'}.png`));
    for (const path of ['/presentes/../segredo.png', 'https://outro.example/a.png', '/presentes/a.jpg', '//outro.example/presentes/a.png']) {
      expect(await fetchGiftPhoto(SITE, path, serve(() => new Response(png)))).toBeNull();
    }
    expect(urls).toHaveLength(4);
    expect(toBase64(new Uint8Array(70_000).fill(65))).toBe(Buffer.alloc(70_000, 65).toString('base64'));
  });

  it('sem parcelamento, só cobrança avulsa', () => {
    const parsed = parseCheckoutRequest({ giftId: 'varinha', method: 'card' }, { ...CATALOG, maxInstallments: 1 });
    if (!parsed.ok) throw new Error('esperava ok');
    const body = asaasCheckoutBody({ id: 'o1', ...parsed.value }, { ...CATALOG, maxInstallments: 1 }, 'img', SITE);
    expect(body.chargeTypes).toEqual(['DETACHED']);
    expect(body).not.toHaveProperty('installment');
  });
});
