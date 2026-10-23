/**
 * Teste de carga do canal do WhatsApp: 60 famílias escrevendo ao mesmo tempo.
 *
 * Webhook → fila (PGlite com as migrações reais) → orquestrador → agente → Evolution,
 * com um Claude falso que decide pelo contexto de cada remetente (registra a resposta
 * e depois responde citando o nome) e uma Evolution falsa com latência e uma queda
 * de "Connection Closed" no meio do pico. Nada sai para a rede.
 *
 * Confere que ninguém fica sem resposta, que nenhuma conversa se mistura com outra,
 * que quem escreve em partes recebe uma resposta só, que eventos repetidos não geram
 * resposta dupla, que cada resposta vai para a pessoa certa no banco e que filas e
 * travas terminam limpas.
 *
 * Limite: o PGlite executa uma consulta por vez, então o teste exercita as travas
 * e a intercalação do código (await a await), não a concorrência real do Postgres.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevDatabase, pgliteRpc } from '../scripts/lib/pglite-db.ts';
import { createAgent, type MessagesClient } from '../supabase/functions/_shared/agent/index.ts';
import { createRepository, type Rpc } from '../supabase/functions/_shared/repo.ts';
import { createWhatsAppBot } from '../supabase/functions/_shared/whatsapp/bot.ts';
import { EvolutionError, type WhatsAppClient } from '../supabase/functions/_shared/whatsapp/evolution.ts';
import { createWebhookHandler } from '../supabase/functions/_shared/whatsapp/http.ts';
import { contentText, reply, text, thinking, toolUse } from './support/agent.ts';

const FAMILIES = 60;
const SPLIT_SENDERS = 15; // escrevem em duas partes
const DUPLICATED = 10; // a Evolution entrega o mesmo evento duas vezes
const OUTAGE_MS = 120; // queda da Evolution logo no primeiro envio
const SECRET = 's'.repeat(40);
const INSTANCE = 'convite';

const pad = (n: number) => String(n).padStart(2, '0');
const phoneOf = (i: number) => `55319910000${pad(i)}`;
const adultOf = (i: number) => `Convidado ${pad(i)} Carga`;
const minorOf = (i: number) => `Filho ${pad(i)} Carga`;
const hasMinor = (i: number) => i % 2 === 0;
const declines = (i: number) => i % 4 === 0;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const jitter = (min: number, max: number) => sleep(min + Math.random() * (max - min));

/** Mede quantas chamadas estão em andamento ao mesmo tempo. */
class Gauge {
  now = 0;
  peak = 0;
  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.peak = Math.max(this.peak, ++this.now);
    try {
      return await fn();
    } finally {
      this.now--;
    }
  }
}

/**
 * Claude falso e sem roteiro fixo: lê o contexto do turno (quem é o remetente e
 * os ids da família), registra a resposta e, depois do resultado da ferramenta,
 * responde em duas partes com o nome do remetente.
 */
class ContextualClaude implements MessagesClient {
  readonly gauge = new Gauge();
  requests = 0;

  readonly messages = {
    create: (params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> =>
      this.gauge.run(async () => {
        this.requests++;
        await jitter(50, 400);
        const context = contentText(params.messages.filter((m) => (m.role as string) === 'system').at(-1)!);
        const sender = /Remetente: (.+?), identificado pelo telefone/.exec(context)?.[1];
        if (!sender) throw new Error(`contexto sem remetente identificado:\n${context}`);

        const last = params.messages.at(-1)!;
        const afterTool = Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result');
        if (afterTool) {
          return reply([
            thinking(),
            text(`Registrei a resposta de ${sender}, tudo certo por aqui!\n\n${sender}, a coruja já levou o recado ao castelo.`),
          ]);
        }

        const said = params.messages
          .filter((m) => m.role === 'user')
          .map(contentText)
          .join(' ');
        const presenca = /não vou/i.test(said) ? 'nao' : 'sim';
        const ids = [...context.matchAll(/pode responder: sim \[id ([0-9a-f-]{36})\]/g)].map((m) => m[1]!);
        return reply([thinking(), toolUse('registrar_resposta', { respostas: ids.map((convidado_id) => ({ convidado_id, presenca })) })], 'tool_use');
      }),
  };
}

type Sent = { type: 'text' | 'reaction' | 'read'; to: string; value: string; at: number };

/** Evolution falsa: latência, pico de concorrência e uma queda no início. */
class LoadWhatsApp implements WhatsAppClient {
  readonly gauge = new Gauge();
  readonly events: Sent[] = [];
  outageUntil: number | null = null;
  failedAttempts = 0;

  async sendText(phone: string, value: string) {
    await this.gauge.run(async () => {
      const start = Date.now();
      this.outageUntil ??= start + OUTAGE_MS;
      await jitter(10, 80);
      if (start < this.outageUntil) {
        this.failedAttempts++;
        throw new EvolutionError('/message/sendText', 400, '{"response":{"message":["Error: Connection Closed"]}}');
      }
      this.events.push({ type: 'text', to: phone, value, at: Date.now() });
    });
  }
  async sendReaction(remoteJid: string, waMessageId: string, emoji: string) {
    await this.gauge.run(async () => {
      await jitter(10, 50);
      this.events.push({ type: 'reaction', to: remoteJid, value: `${waMessageId} ${emoji}`, at: Date.now() });
    });
  }
  async markRead(remoteJid: string, ids: string[]) {
    this.events.push({ type: 'read', to: remoteJid, value: ids.join(','), at: Date.now() });
  }
  async downloadMedia(): Promise<{ base64: string; mimetype: string }> {
    throw new Error('sem áudio neste teste');
  }
  of(type: Sent['type'], to: string) {
    return this.events.filter((e) => e.type === type && e.to === to);
  }
}

let db: PGlite;
let rpc: Rpc;

beforeAll(async () => {
  db = await createDevDatabase();
  rpc = pgliteRpc(db);
  const rows = [];
  for (let i = 1; i <= FAMILIES; i++) {
    const household = `Família Carga ${pad(i)}`;
    rows.push({ household, full_name: adultOf(i), phone: `(31) 99100-00${pad(i)}`, relationship: 'mãe' });
    if (hasMinor(i)) rows.push({ household, full_name: minorOf(i), relationship: 'filho', is_minor: true });
  }
  const result = (await rpc('admin_import_guests', { p_rows: rows, p_apply: true })) as { errors: unknown[] };
  expect(result.errors).toEqual([]);
});

afterAll(async () => {
  await db.close();
});

describe('carga: 60 famílias ao mesmo tempo', () => {
  it('todas respondidas, sem misturar conversas, sem resposta dupla e com o banco certo', { timeout: 60_000 }, async () => {
    const claude = new ContextualClaude();
    const whatsapp = new LoadWhatsApp();
    const logs: { event: string; data?: Record<string, unknown> }[] = [];
    const log = (event: string, data?: Record<string, unknown>) => logs.push({ event, data });
    const agent = createAgent({ repo: createRepository(rpc), client: claude, clock: () => new Date() });
    const bot = createWhatsAppBot({
      rpc,
      agent,
      whatsapp,
      transcriber: null,
      adminPhones: [],
      options: { quietMs: 300, maxGatherMs: 3_000, sendRetryDelaysMs: [60, 150] },
      typingMs: () => 0,
      log,
    });
    const jobs: Promise<unknown>[] = [];
    const webhook = createWebhookHandler({ secret: SECRET, instance: INSTANCE, rpc, bot, background: (p) => jobs.push(p), log });

    const ids = new Map<number, string[]>(); // família → ids das mensagens enviadas pelo convidado
    let seq = 0;
    const post = (i: number, body: string, id = `LOAD${++seq}`) => {
      ids.set(i, [...(ids.get(i) ?? []), id]);
      const payload = {
        event: 'messages.upsert',
        instance: INSTANCE,
        data: {
          key: { id, fromMe: false, remoteJid: `${phoneOf(i)}@s.whatsapp.net` },
          pushName: adultOf(i),
          message: { conversation: body },
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      };
      return webhook(
        new Request('https://fn.test/whatsapp-webhook', {
          method: 'POST',
          headers: { 'x-sofia-secret': SECRET, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }),
      );
    };
    const answer = (i: number) => (declines(i) ? 'Infelizmente não vou poder ir.' : 'Vou sim, com certeza!');

    // Todos ao mesmo tempo. Uns escrevem em duas partes; para outros a Evolution repete o evento.
    const started = Date.now();
    const sends: Promise<Response>[] = [];
    for (let i = 1; i <= FAMILIES; i++) {
      if (i <= SPLIT_SENDERS) {
        sends.push(post(i, 'Oi, Professora!'));
        sends.push(sleep(100).then(() => post(i, answer(i))));
      } else if (i <= SPLIT_SENDERS + DUPLICATED) {
        const id = `LOAD${++seq}`;
        sends.push(post(i, answer(i), id), post(i, answer(i), id));
      } else {
        sends.push(post(i, answer(i)));
      }
    }
    const responses = await Promise.all(sends);
    expect(responses.every((r) => r.status === 200)).toBe(true);
    for (let done = 0; done < jobs.length; done = jobs.length) await Promise.all(jobs.slice(done));
    const elapsed = Date.now() - started;

    // Cada família: exatamente uma resposta (duas partes), só com o próprio nome.
    for (let i = 1; i <= FAMILIES; i++) {
      const texts = whatsapp.of('text', phoneOf(i)).map((e) => e.value);
      expect(texts, `família ${i}`).toEqual([
        `Registrei a resposta de ${adultOf(i)}, tudo certo por aqui!`,
        `${adultOf(i)}, a coruja já levou o recado ao castelo.`,
      ]);

      // Reação certa, na conversa certa, numa mensagem dessa pessoa.
      const reactions = whatsapp.of('reaction', `${phoneOf(i)}@s.whatsapp.net`).map((e) => e.value.split(' '));
      expect(reactions, `reação da família ${i}`).toHaveLength(1);
      expect(ids.get(i)).toContain(reactions[0]![0]);
      expect(reactions[0]![1]).toBe(declines(i) ? '😢' : '❤️');
    }
    // Nenhum texto para número fora da lista.
    const phones = new Set(Array.from({ length: FAMILIES }, (_, k) => phoneOf(k + 1)));
    expect(whatsapp.events.filter((e) => e.type === 'text' && !phones.has(e.to))).toEqual([]);

    // Banco: cada pessoa com a própria resposta, registrada pelo adulto da própria família.
    const guests = await db.query<{ full_name: string; rsvp_status: string; by_name: string | null }>(`
      select g.full_name, g.rsvp_status, b.full_name as by_name
        from public.guests g left join public.guests b on b.id = g.rsvp_updated_by`);
    expect(guests.rows).toHaveLength(FAMILIES + FAMILIES / 2);
    for (const g of guests.rows) {
      const i = Number(/(\d{2}) Carga$/.exec(g.full_name)![1]);
      expect(g.rsvp_status, g.full_name).toBe(declines(i) ? 'declined' : 'attending');
      expect(g.by_name, g.full_name).toBe(adultOf(i));
    }

    // Um turno por família (quem escreveu em partes também), duas chamadas ao modelo cada.
    const usage = await db.query<{ turns: number }>('select coalesce(sum(turns), 0)::int as turns from public.bot_usage');
    expect(usage.rows[0]!.turns).toBe(FAMILIES);
    expect(claude.requests).toBe(FAMILIES * 2);

    // A queda da Evolution aconteceu e foi absorvida pelas novas tentativas.
    expect(whatsapp.failedAttempts).toBeGreaterThan(0);
    expect(logs.filter((l) => l.event === 'send_retry').length).toBe(whatsapp.failedAttempts);
    expect(logs.filter((l) => ['send_failed', 'turn_failed', 'reaction_failed', 'release_failed'].includes(l.event))).toEqual([]);

    // Filas e travas limpas.
    const pending = await db.query<{ n: number }>('select count(*)::int as n from public.wa_inbox where processed_at is null');
    expect(pending.rows[0]!.n).toBe(0);
    const locked = await db.query<{ n: number }>('select count(*)::int as n from public.wa_contacts where lease_until is not null');
    expect(locked.rows[0]!.n).toBe(0);

    console.info(
      `[carga] ${FAMILIES} famílias em ${(elapsed / 1000).toFixed(1)} s; ` +
        `pico de ${claude.gauge.peak} chamadas simultâneas ao Claude e ${whatsapp.gauge.peak} à Evolution; ` +
        `${whatsapp.failedAttempts} envios falharam na queda e foram repetidos.`,
    );
  });
});
