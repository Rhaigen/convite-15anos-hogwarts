/**
 * site-gifts: progresso das vaquinhas da lista de presentes, para o site (só GET, sem chave).
 *
 *   GET → { gifts: [{ id, raisedCents, goalCents }] }
 *
 * Soma só os pedidos PAGOS (confirmados pelo webhook do Asaas). Não sai nada de quem
 * deu nem das mensagens. CORS só do convite, cache curto, erro genérico (503).
 */
import type { Rpc } from '../repo.ts';
import type { GiftCatalog } from './catalogTypes.ts';

type Logger = (event: string, data?: Record<string, unknown>) => void;

export interface FundProgress {
  id: string;
  raisedCents: number;
  goalCents: number;
}

export interface SiteGiftsDeps {
  rpc: Rpc;
  allowedOrigins: string[];
  catalog: GiftCatalog;
  log?: Logger;
  cacheSeconds?: number;
  clock?: () => number;
}

/** Junta as somas do banco às metas do catálogo (vaquinha sem pagamento = 0). */
export function toProgress(raw: unknown, catalog: GiftCatalog): FundProgress[] {
  const raised = new Map<string, number>();
  for (const item of Array.isArray(raw) ? raw : []) {
    const r = (item ?? {}) as { gift_id?: unknown; raised_cents?: unknown };
    const cents = Number(r.raised_cents);
    if (typeof r.gift_id === 'string' && Number.isFinite(cents) && cents >= 0) raised.set(r.gift_id, Math.round(cents));
  }
  return catalog.gifts.flatMap((g) => (g.kind === 'fund' ? [{ id: g.id, raisedCents: raised.get(g.id) ?? 0, goalCents: g.goalCents }] : []));
}

export function createSiteGiftsHandler(deps: SiteGiftsDeps): (req: Request) => Promise<Response> {
  const log = deps.log ?? (() => {});
  const cacheSeconds = deps.cacheSeconds ?? 60;
  const clock = deps.clock ?? Date.now;
  let cached: { at: number; body: string } | null = null;

  const corsHeaders = (req: Request): Record<string, string> => {
    const origin = req.headers.get('Origin');
    return {
      Vary: 'Origin',
      ...(origin && deps.allowedOrigins.includes(origin)
        ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' }
        : {}),
    };
  };

  async function load(): Promise<string> {
    const now = clock();
    if (cached && now - cached.at < cacheSeconds * 1000) return cached.body;
    const hasFunds = deps.catalog.gifts.some((g) => g.kind === 'fund');
    const body = JSON.stringify({ gifts: hasFunds ? toProgress(await deps.rpc('bot_gift_progress', {}), deps.catalog) : [] });
    cached = { at: now, body };
    return body;
  }

  return async (req) => {
    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'GET') return new Response(null, { status: 405, headers: { ...cors, Allow: 'GET, OPTIONS' } });

    const json = { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' };
    try {
      return new Response(await load(), { status: 200, headers: { ...cors, ...json, 'Cache-Control': `public, max-age=${cacheSeconds}` } });
    } catch (error) {
      log('site_gifts_failed', { error: String(error) });
      return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503, headers: { ...cors, ...json, 'Cache-Control': 'no-store' } });
    }
  };
}
