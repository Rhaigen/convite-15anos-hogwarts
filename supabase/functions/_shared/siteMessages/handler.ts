/**
 * O Salão Principal: a única leitura pública do banco. O site busca aqui as cartas
 * (recados aprovados pelos organizadores) e não usa chave nem cliente do Supabase.
 *
 *   GET → public.bot_site_messages() com o service_role → { sealed, unsealAt, letters }
 *
 * O selo é do banco: antes de unseal_at o texto nem sai dele. Este módulo só
 * repassa os campos permitidos (id opaco, remetente e, aberto, o texto), põe CORS
 * do domínio do convite e cache curto. Erro nunca vaza detalhe: 503 genérico.
 */
import type { Rpc } from '../repo.ts';

type Logger = (event: string, data?: Record<string, unknown>) => void;

export interface WallLetter {
  id: string;
  from: string;
  /** Só depois que os selos se rompem. */
  body?: string;
}

export interface WallResponse {
  sealed: boolean;
  unsealAt: string;
  letters: WallLetter[];
}

export interface SiteMessagesDeps {
  rpc: Rpc;
  /** Origens do convite que podem ler a resposta no navegador (SITE_ORIGINS). */
  allowedOrigins: string[];
  log?: Logger;
  /** Cache no navegador/CDN e na memória da função (segundos). */
  cacheSeconds?: number;
  clock?: () => number;
}

/** "https://a.com/, http://localhost:5173" → origens normalizadas, sem barra final. */
export function parseOrigins(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter((o) => /^https?:\/\/[^/\s]+$/.test(o));
}

const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** Copia só os campos permitidos; descarta qualquer coisa fora do formato. */
export function toWallResponse(raw: unknown): WallResponse {
  const data = (raw ?? {}) as { sealed?: unknown; unseal_at?: unknown; letters?: unknown };
  const sealed = data.sealed !== false;
  const letters = (Array.isArray(data.letters) ? data.letters : []).flatMap((item): WallLetter[] => {
    const l = (item ?? {}) as Record<string, unknown>;
    if (!isText(l.id, 64) || !isText(l.from, 120)) return [];
    if (sealed) return [{ id: l.id, from: l.from }];
    return isText(l.body, 1000) ? [{ id: l.id, from: l.from, body: l.body }] : [];
  });
  return { sealed, unsealAt: typeof data.unseal_at === 'string' ? data.unseal_at : '', letters };
}

export function createSiteMessagesHandler(deps: SiteMessagesDeps): (req: Request) => Promise<Response> {
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
    const body = JSON.stringify(toWallResponse(await deps.rpc('bot_site_messages', {})));
    cached = { at: now, body };
    return body;
  }

  return async (req) => {
    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'GET') return new Response(null, { status: 405, headers: { ...cors, Allow: 'GET, OPTIONS' } });

    const json = { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' };
    try {
      return new Response(await load(), {
        status: 200,
        headers: { ...cors, ...json, 'Cache-Control': `public, max-age=${cacheSeconds}` },
      });
    } catch (error) {
      log('site_messages_failed', { error: String(error) });
      return new Response(JSON.stringify({ error: 'unavailable' }), {
        status: 503,
        headers: { ...cors, ...json, 'Cache-Control': 'no-store' },
      });
    }
  };
}
