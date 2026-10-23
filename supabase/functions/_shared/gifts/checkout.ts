/**
 * gift-checkout: o site pede um presente da lista e recebe o link do checkout do Asaas.
 *
 *   POST { giftId, method, amountCents?, message?, signature?, anonymous?, website? } → { url }
 *
 * `method` ('pix' | 'card') é o botão que o convidado apertou: o preço sai da tabela daquela
 * forma e o checkout do Asaas só oferece ela.
 *
 * Única escrita pública do convite, então tudo é conferido aqui:
 * - origem do convite obrigatória (SITE_ORIGINS), só JSON pequeno, campo-isca contra robôs;
 * - o PREÇO vem da cópia da lista no servidor (catalog.ts) e da mesma fórmula do site
 *   (pricing.ts): nada de valor vindo do navegador;
 * - limite de tentativas no banco (por hash do IP, com sal secreto, e total por dia);
 * - a chave do Asaas só sai daqui para api.asaas.com / api-sandbox.asaas.com;
 * - os endereços de volta saem do secret SITE_URL, nunca do pedido;
 * - o link devolvido precisa ser https em asaas.com;
 * - a foto do item vem do próprio convite (SITE_URL), só PNG pequeno; sem ela, vai o brasão.
 * Erro nunca vaza detalhe: o navegador recebe só um código genérico.
 * Ver docs/arquitetura.md#lista-de-presentes.
 */
import type { Rpc } from '../repo.ts';
import type { CatalogGift, GiftCatalog } from './catalogTypes.ts';
import { chargedCents, PAYMENT_METHODS, type PaymentMethod } from './pricing.ts';

type Logger = (event: string, data?: Record<string, unknown>) => void;

export const MESSAGE_MAX = 500;
export const SIGNATURE_MAX = 60;
const BODY_MAX = 4096;
const ASAAS_API_HOSTS = ['api.asaas.com', 'api-sandbox.asaas.com'];
const PHOTO_PATH = /^\/presentes\/[a-z0-9-]+\.png$/;
const PHOTO_MAX_BYTES = 150_000;
const PHOTO_TIMEOUT_MS = 4_000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface GiftCheckoutDeps {
  rpc: Rpc;
  /** Origens do convite que podem pedir (SITE_ORIGINS). */
  allowedOrigins: string[];
  catalog: GiftCatalog;
  /** Imagem (PNG em base64) dos itens no checkout quando o presente não tem foto; o Asaas exige. */
  imageBase64: string;
  /** ASAAS_API_URL (https://api.asaas.com ou https://api-sandbox.asaas.com) e ASAAS_API_KEY. */
  asaas: { apiUrl: string; apiKey: string };
  /** SITE_URL: endereço do convite para onde o Asaas devolve o convidado. */
  siteUrl: string;
  /** GIFT_IP_SALT: sal do hash do IP (o IP em si nunca é gravado). */
  ipSalt: string;
  fetch?: typeof fetch;
  log?: Logger;
  timeoutMs?: number;
}

export interface ParsedCheckout {
  gift: CatalogGift;
  method: PaymentMethod;
  baseCents: number;
  chargedCents: number;
  message: string | null;
  signature: string | null;
  anonymous: boolean;
}

export type ParseError = 'invalid' | 'signature_required' | 'bot';

/** Controles (menos a quebra de linha), larguras zero e marcas de direção do texto. */
function isUnsafeChar(code: number): boolean {
  return (
    (code < 0x20 && code !== 0x0a) ||
    code === 0x7f ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * Normaliza um texto do convidado: sem caracteres de controle, quebras de linha só na
 * mensagem (no máximo uma linha em branco seguida), espaços aparados.
 * `null` = vazio; `undefined` = inválido (tipo errado ou longo demais).
 */
export function normalizeText(value: unknown, max: number, multiline: boolean): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  let text = Array.from(value.replace(/\r\n?/g, '\n'))
    .filter((ch) => !isUnsafeChar(ch.codePointAt(0) ?? 0))
    .join('');
  text = multiline
    ? text
        .split('\n')
        .map((l) => l.replace(/[ \t]+/g, ' ').trim())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    : text.replace(/\s+/g, ' ').trim();
  if (text.length === 0) return null;
  return text.length <= max ? text : undefined;
}

/** Confere o pedido do navegador contra o catálogo do servidor. */
export function parseCheckoutRequest(raw: unknown, catalog: GiftCatalog): { ok: true; value: ParsedCheckout } | { ok: false; error: ParseError } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'invalid' };
  const body = raw as Record<string, unknown>;
  const allowed = new Set(['giftId', 'method', 'amountCents', 'message', 'signature', 'anonymous', 'website']);
  if (Object.keys(body).some((k) => !allowed.has(k))) return { ok: false, error: 'invalid' };
  // Campo-isca: invisível para pessoas, preenchido por robôs.
  if (body.website !== undefined && body.website !== '') return { ok: false, error: 'bot' };

  const gift = typeof body.giftId === 'string' ? catalog.gifts.find((g) => g.id === body.giftId) : undefined;
  if (!gift) return { ok: false, error: 'invalid' };
  const method = PAYMENT_METHODS.find((m) => m === body.method);
  if (!method) return { ok: false, error: 'invalid' };

  let baseCents: number;
  if (gift.kind === 'quota') {
    if (body.amountCents !== undefined && body.amountCents !== null) return { ok: false, error: 'invalid' };
    baseCents = gift.amountCents;
  } else {
    const amount = body.amountCents;
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < catalog.fundMinCents || amount > catalog.fundMaxCents) {
      return { ok: false, error: 'invalid' };
    }
    baseCents = amount;
  }

  const message = normalizeText(body.message, MESSAGE_MAX, true);
  const signatureRaw = normalizeText(body.signature, SIGNATURE_MAX, false);
  if (message === undefined || signatureRaw === undefined) return { ok: false, error: 'invalid' };
  if (body.anonymous !== undefined && typeof body.anonymous !== 'boolean') return { ok: false, error: 'invalid' };
  const anonymous = message !== null && body.anonymous === true;
  const signature = message !== null && !anonymous ? signatureRaw : null;
  if (message !== null && !anonymous && signature === null) return { ok: false, error: 'signature_required' };

  return {
    ok: true,
    value: {
      gift,
      method,
      baseCents,
      chargedCents: chargedCents(baseCents, method, catalog.fees, catalog.maxInstallments),
      message,
      signature,
      anonymous,
    },
  };
}

/** Endereço do convite válido para os retornos do Asaas (https, ou localhost no teste). */
export function normalizeSiteUrl(value: string | undefined): string | null {
  const url = (value ?? '').trim().replace(/\/+$/, '');
  if (/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(url)) return url;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(url)) return url;
  return null;
}

/** Base da API do Asaas, só se for um dos endereços oficiais (a chave não vai para outro lugar). */
export function normalizeAsaasApiUrl(value: string | undefined): string | null {
  try {
    const url = new URL((value ?? '').trim());
    return url.protocol === 'https:' && ASAAS_API_HOSTS.includes(url.hostname) && (url.pathname === '/' || url.pathname === '')
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

/** Link do checkout devolvido ao navegador: só https em asaas.com. */
export function isAsaasCheckoutUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'asaas.com' || url.hostname.endsWith('.asaas.com')) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** HMAC-SHA256(sal, ip) em hexadecimal. */
export async function hashIp(ip: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** IP do visitante como a plataforma informa (o primeiro do X-Forwarded-For). */
export function clientIp(req: Request): string | null {
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const ip = forwarded || req.headers.get('cf-connecting-ip')?.trim() || req.headers.get('x-real-ip')?.trim();
  return ip && ip.length <= 64 ? ip : null;
}

/** Bytes → base64, em blocos (String.fromCharCode com argumentos demais estoura a pilha). */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Foto do presente para o item do checkout, em base64: o PNG que `npm run gifts:images` gera
 * em public/presentes/ e o convite publica (as fotos não ficam no catálogo nem no repositório:
 * fotos de lojas têm dono). Sem foto, fora do ar, não é PNG ou grande demais: null (vai o brasão).
 */
export async function fetchGiftPhoto(siteUrl: string, path: string, doFetch: typeof fetch, timeoutMs = PHOTO_TIMEOUT_MS): Promise<string | null> {
  if (!PHOTO_PATH.test(path)) return null;
  try {
    const res = await doFetch(`${siteUrl}${path}`, { headers: { Accept: 'image/png' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok || Number(res.headers.get('Content-Length') ?? 0) > PHOTO_MAX_BYTES) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > PHOTO_MAX_BYTES || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) return null;
    return toBase64(bytes);
  } catch {
    return null;
  }
}

/** Corpo do POST /v3/checkouts do Asaas: só a forma de pagamento escolhida no site. */
export function asaasCheckoutBody(order: { id: string } & ParsedCheckout, catalog: GiftCatalog, imageBase64: string, siteUrl: string) {
  const back = (state: string) => `${siteUrl}/?presente=${state}`;
  const installments = order.method === 'card' && catalog.maxInstallments > 1;
  return {
    billingTypes: order.method === 'pix' ? ['PIX'] : ['CREDIT_CARD'],
    chargeTypes: installments ? ['DETACHED', 'INSTALLMENT'] : ['DETACHED'],
    ...(installments ? { installment: { maxInstallmentCount: catalog.maxInstallments } } : {}),
    minutesToExpire: 60,
    externalReference: order.id,
    // Sem volta automática: o checkout ignora `autoRedirect` (testado no sandbox em 2026-10-18);
    // o convidado volta pelo botão "Acompanhar meu pedido" do Asaas.
    callback: { successUrl: back('enviado'), cancelUrl: back('cancelado'), expiredUrl: back('expirado') },
    items: [
      {
        name: order.gift.checkoutName,
        description: order.gift.checkoutDescription,
        quantity: 1,
        value: order.chargedCents / 100,
        imageBase64,
        externalReference: order.gift.id,
      },
    ],
  };
}

export function createGiftCheckoutHandler(deps: GiftCheckoutDeps): (req: Request) => Promise<Response> {
  const log = deps.log ?? (() => {});
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 12_000;
  const siteUrl = normalizeSiteUrl(deps.siteUrl);
  const apiUrl = normalizeAsaasApiUrl(deps.asaas.apiUrl);
  const configured = Boolean(siteUrl && apiUrl && deps.asaas.apiKey && deps.ipSalt.length >= 16);
  // Fotos já baixadas nesta instância da função (só as que deram certo).
  const photos = new Map<string, string>();
  const loadPhoto = async (path: string | undefined): Promise<string | null> => {
    if (!path || !siteUrl) return null;
    const cached = photos.get(path);
    if (cached) return cached;
    const photo = await fetchGiftPhoto(siteUrl, path, doFetch, Math.min(PHOTO_TIMEOUT_MS, timeoutMs));
    if (photo) photos.set(path, photo);
    else log('gift_photo_unavailable', { path });
    return photo;
  };

  const corsHeaders = (req: Request): Record<string, string> => {
    const origin = req.headers.get('Origin');
    return {
      Vary: 'Origin',
      ...(origin && deps.allowedOrigins.includes(origin)
        ? {
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '86400',
          }
        : {}),
    };
  };

  return async (req) => {
    const cors = corsHeaders(req);
    const reply = (status: number, body: Record<string, unknown>) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST') return new Response(null, { status: 405, headers: { ...cors, Allow: 'POST, OPTIONS' } });

    const origin = req.headers.get('Origin');
    if (!origin || !deps.allowedOrigins.includes(origin)) return reply(403, { error: 'forbidden' });
    if (!(req.headers.get('Content-Type') ?? '').toLowerCase().startsWith('application/json')) return reply(415, { error: 'invalid' });
    if (!configured) {
      log('gift_checkout_not_configured', { siteUrl: Boolean(siteUrl), apiUrl: Boolean(apiUrl), apiKey: Boolean(deps.asaas.apiKey) });
      return reply(503, { error: 'unavailable' });
    }

    let raw: unknown;
    try {
      const text = await req.text();
      if (text.length > BODY_MAX) return reply(413, { error: 'invalid' });
      raw = JSON.parse(text);
    } catch {
      return reply(400, { error: 'invalid' });
    }

    const parsed = parseCheckoutRequest(raw, deps.catalog);
    if (!parsed.ok) {
      log('gift_checkout_rejected', { reason: parsed.error });
      return reply(400, { error: parsed.error === 'signature_required' ? 'signature_required' : 'invalid' });
    }
    const order = parsed.value;
    // A foto é buscada enquanto o pedido é gravado; nunca falha (sem ela, vai o brasão).
    const photo = loadPhoto(order.gift.photo);

    let orderId: string;
    try {
      const ip = clientIp(req);
      const created = (await deps.rpc('bot_create_gift_order', {
        p_gift_id: order.gift.id,
        p_gift_name: order.gift.name,
        p_kind: order.gift.kind,
        p_payment_method: order.method,
        p_base_cents: order.baseCents,
        p_charged_cents: order.chargedCents,
        p_message: order.message,
        p_signature: order.signature,
        p_anonymous: order.anonymous,
        p_ip_hash: ip ? await hashIp(ip, deps.ipSalt) : null,
      })) as { ok: boolean; id?: string; error?: string };
      if (!created.ok || !created.id) {
        log('gift_order_refused', { reason: created.error });
        if (created.error === 'rate_limited' || created.error === 'busy') return reply(429, { error: 'busy' });
        return reply(400, { error: created.error === 'signature_required' ? 'signature_required' : 'invalid' });
      }
      orderId = created.id;
    } catch (error) {
      log('gift_order_failed', { error: String(error) });
      return reply(503, { error: 'unavailable' });
    }

    const discard = async (reason: string, data: Record<string, unknown> = {}) => {
      log('asaas_checkout_failed', { reason, ...data });
      await deps.rpc('bot_discard_gift_order', { p_order_id: orderId }).catch(() => {});
      return reply(503, { error: 'unavailable' });
    };

    let checkout: { id?: unknown; link?: unknown };
    try {
      const res = await doFetch(`${apiUrl}/v3/checkouts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', access_token: deps.asaas.apiKey, 'User-Agent': 'convite-sofia-15anos' },
        body: JSON.stringify(asaasCheckoutBody({ id: orderId, ...order }, deps.catalog, (await photo) ?? deps.imageBase64, siteUrl!)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        // Só os erros do Asaas (código e descrição, curta) vão para o log; nunca a chave nem dados do pedido.
        const errors = await res
          .json()
          .then((b: { errors?: { code?: unknown; description?: unknown }[] }) =>
            (b.errors ?? []).map((e) => `${String(e.code)}: ${String(e.description ?? '').slice(0, 200)}`).slice(0, 5),
          )
          .catch(() => []);
        return discard('http', { status: res.status, errors });
      }
      checkout = (await res.json()) as typeof checkout;
    } catch (error) {
      return discard('network', { error: String(error) });
    }

    const checkoutId = typeof checkout.id === 'string' && checkout.id.length <= 100 ? checkout.id : null;
    const link =
      checkout.link ??
      (checkoutId ? `https://${apiUrl!.includes('sandbox') ? 'sandbox.' : ''}asaas.com/checkoutSession/show?id=${encodeURIComponent(checkoutId)}` : null);
    if (!checkoutId || !isAsaasCheckoutUrl(link)) return discard('response');

    try {
      await deps.rpc('bot_attach_gift_checkout', { p_order_id: orderId, p_checkout_id: checkoutId });
    } catch (error) {
      // Sem o id gravado, o webhook não acharia o pedido: melhor não mandar pagar.
      return discard('attach', { error: String(error) });
    }
    log('gift_checkout_created', { gift: order.gift.id, kind: order.gift.kind, method: order.method });
    return reply(200, { url: link });
  };
}
