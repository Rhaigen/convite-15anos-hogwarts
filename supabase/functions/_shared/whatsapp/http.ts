/**
 * Handlers HTTP das Edge Functions, sem APIs do Deno (testados no Node):
 *
 *  - webhook (Evolution → Aifos): a Evolution não assina os eventos, então o
 *    webhook exige um segredo longo no cabeçalho `x-sofia-secret` (configurado
 *    no webhook da instância), comparado em tempo constante, e confere o nome da
 *    instância. Grava a mensagem na fila (idempotente pelo id do WhatsApp),
 *    responde 200 na hora e processa em segundo plano.
 *  - cron (pg_cron → Aifos): segredo `x-cron-secret`, conferido no banco contra
 *    o Vault (bot_cron_secret_ok).
 */
import type { Logger } from '../agent/index.ts';
import type { Rpc } from '../repo.ts';
import type { WhatsAppBot } from './bot.ts';
import { parseUpsert } from './inbound.ts';

/** Agenda trabalho depois da resposta (EdgeRuntime.waitUntil nas Edge Functions). */
export type Background = (work: Promise<unknown>) => void;

const MAX_BODY_BYTES = 512 * 1024;

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Comparação em tempo constante (não vaza, pelo tempo, quantos caracteres batem). */
export function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  const length = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function readJson(req: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return { ok: false, response: json(413, { error: 'payload_too_large' }) };
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return { ok: false, response: json(413, { error: 'payload_too_large' }) };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, response: json(400, { error: 'invalid_json' }) };
  }
}

export interface WebhookDeps {
  secret: string;
  instance: string;
  rpc: Rpc;
  bot: Pick<WhatsAppBot, 'processContact'>;
  background: Background;
  log: Logger;
  clock?: () => Date;
}

export function createWebhookHandler(deps: WebhookDeps) {
  if (deps.secret.length < 32) throw new Error('WEBHOOK_SECRET ausente ou curto demais (mínimo 32 caracteres).');

  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
    if (!safeEqual(req.headers.get('x-sofia-secret') ?? '', deps.secret)) {
      deps.log('webhook_unauthorized', {});
      return json(401, { error: 'unauthorized' });
    }
    const body = await readJson(req);
    if (!body.ok) return body.response;

    const parsed = parseUpsert(body.value, { instance: deps.instance, now: deps.clock?.() });
    if (!parsed.ok) {
      if (parsed.reason !== 'from_me' && parsed.reason !== 'not_message_event') deps.log('webhook_ignored', { reason: parsed.reason });
      return json(200, { ok: true, ignored: parsed.reason });
    }

    const m = parsed.message;
    // Erro aqui devolve 500: a Evolution tenta de novo, e o id evita duplicar.
    const added = (await deps.rpc('bot_inbox_add', {
      p_wa_message_id: m.waMessageId,
      p_phone: m.phone,
      p_push_name: m.pushName,
      p_kind: m.kind,
      p_body: m.body,
      p_audio_seconds: m.audioSeconds,
      p_remote_jid: m.remoteJid,
    })) as { inserted: boolean };

    if (added.inserted) {
      deps.background(
        deps.bot.processContact(m.phone).catch((error) => deps.log('process_failed', { error: String(error) })),
      );
    }
    return json(200, { ok: true, queued: added.inserted });
  };
}

export interface CronDeps {
  rpc: Rpc;
  bot: Pick<WhatsAppBot, 'tick' | 'dailyReport'>;
  background: Background;
  log: Logger;
}

export function createCronHandler(deps: CronDeps) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
    const secret = req.headers.get('x-cron-secret') ?? '';
    if (!secret || (await deps.rpc('bot_cron_secret_ok', { p_secret: secret })) !== true) {
      deps.log('cron_unauthorized', {});
      return json(401, { error: 'unauthorized' });
    }
    const body = await readJson(req);
    if (!body.ok) return body.response;
    const job = (body.value as { job?: unknown } | null)?.job;

    const run = (name: string, work: () => Promise<unknown>) => {
      deps.background(
        work().then(
          (result) => deps.log('cron_done', { job: name, result: result as unknown }),
          (error) => deps.log('cron_failed', { job: name, error: String(error) }),
        ),
      );
      return json(202, { ok: true, job: name });
    };

    if (job === 'tick') return run('tick', deps.bot.tick);
    if (job === 'daily-report') return run('daily-report', deps.bot.dailyReport);
    return json(400, { error: 'unknown_job' });
  };
}
