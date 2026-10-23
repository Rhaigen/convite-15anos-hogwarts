/**
 * Canal do WhatsApp de ponta a ponta, sem rede: webhook → fila (PGlite com as
 * migrações reais) → orquestrador → agente (cliente Anthropic falso) → Evolution
 * falsa. Cobre autenticação, idempotência, mensagens juntas, trava por contato,
 * reações, áudio, comandos do organizador, recados, falhas, cron e o SQL novo.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAgent } from '../supabase/functions/_shared/agent/index.ts';
import { FIXED_REPLIES, IDENTITY_REPLIES } from '../supabase/functions/_shared/agent/prompt.ts';
import { createRepository, type Rpc } from '../supabase/functions/_shared/repo.ts';
import { createWhatsAppBot, type BotDeps } from '../supabase/functions/_shared/whatsapp/bot.ts';
import { EvolutionError, type WhatsAppClient } from '../supabase/functions/_shared/whatsapp/evolution.ts';
import { createCronHandler, createWebhookHandler } from '../supabase/functions/_shared/whatsapp/http.ts';
import { PROFETA_REPLIES, type ProfetaClient, type ProfetaSendResult, type ProfetaSummary } from '../supabase/functions/_shared/whatsapp/profeta.ts';
import type { Transcriber } from '../supabase/functions/_shared/whatsapp/transcriber.ts';
import { call, contentText, createTestDb, DEMO_PHONES, FakeClient, say, type TestDb } from './support/agent.ts';

const { carlos, marta, joao, desconhecido } = DEMO_PHONES;
const SECRET = 's'.repeat(40);
const INSTANCE = 'convite';
/** 10h em Brasília, antes da festa: dentro do horário de retomada. */
const MORNING = new Date('2026-11-10T13:00:00Z');

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await t.db.close();
});

beforeEach(async () => {
  await t.reset();
});

type Event = { type: 'text' | 'reaction' | 'read' | 'download'; to: string; value: string; typingMs?: number };

class FakeWhatsApp implements WhatsAppClient {
  readonly events: Event[] = [];
  failSends = 0;
  sendError: Error = new Error('Evolution fora do ar');
  sendAttempts = 0;
  media = { base64: btoa('OggS'), mimetype: 'audio/ogg; codecs=opus' };

  async sendText(phone: string, text: string, typingMs = 0) {
    this.sendAttempts++;
    if (this.failSends > 0) {
      this.failSends--;
      throw this.sendError;
    }
    this.events.push({ type: 'text', to: phone, value: text, typingMs });
  }
  async sendReaction(remoteJid: string, waMessageId: string, emoji: string) {
    this.events.push({ type: 'reaction', to: remoteJid, value: `${waMessageId} ${emoji}` });
  }
  async markRead(remoteJid: string, ids: string[]) {
    this.events.push({ type: 'read', to: remoteJid, value: ids.join(',') });
  }
  async downloadMedia(waMessageId: string) {
    this.events.push({ type: 'download', to: '', value: waMessageId });
    return this.media;
  }
  texts(to?: string) {
    return this.events.filter((e) => e.type === 'text' && (!to || e.to === to)).map((e) => e.value);
  }
}

interface Setup {
  client?: FakeClient;
  transcriber?: Transcriber | null;
  adminPhones?: string[];
  staffPhones?: string[];
  quietMs?: number;
  maxGatherMs?: number;
  sleep?: (ms: number) => Promise<void>;
  rpc?: Rpc;
  clock?: Date;
  profeta?: BotDeps['profeta'];
}

function setup(options: Setup = {}) {
  const client = options.client ?? new FakeClient();
  const whatsapp = new FakeWhatsApp();
  const logs: { event: string; data?: Record<string, unknown> }[] = [];
  const log = (event: string, data?: Record<string, unknown>) => logs.push({ event, data });
  const rpc = options.rpc ?? t.rpc;
  // Relógio real por padrão (o mesmo do banco); horário fixo só nos testes de horário.
  const clock = () => options.clock ?? new Date();
  const agent = createAgent({ repo: createRepository(rpc), client, clock });
  const deps: BotDeps = {
    rpc,
    agent,
    whatsapp,
    transcriber: options.transcriber === undefined ? { transcribe: async () => 'Vou sim, com certeza!' } : options.transcriber,
    adminPhones: options.adminPhones ?? [marta],
    staffPhones: options.staffPhones ?? [],
    profeta: options.profeta ?? null,
    options: { quietMs: options.quietMs ?? 0, maxGatherMs: options.maxGatherMs ?? 30_000, sendRetryDelaysMs: [5, 15] },
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    typingMs: (text) => text.length,
    log,
    clock,
  };
  const bot = createWhatsAppBot(deps);
  const jobs: Promise<unknown>[] = [];
  const webhook = createWebhookHandler({ secret: SECRET, instance: INSTANCE, rpc, bot, background: (p) => jobs.push(p), log });
  /** Espera todo o trabalho em segundo plano (inclusive o agendado durante a espera). */
  const settle = async () => {
    for (let done = 0; done < jobs.length; done = jobs.length) await Promise.all(jobs.slice(done));
  };
  return { client, whatsapp, logs, bot, webhook, settle, jobs, agent };
}

let seq = 0;

function payload(phone: string, message: Record<string, unknown>, key: Record<string, unknown> = {}) {
  return {
    event: 'messages.upsert',
    instance: INSTANCE,
    data: {
      key: { id: `WA${++seq}`, fromMe: false, remoteJid: `${phone}@s.whatsapp.net`, ...key },
      pushName: 'Convidado',
      message,
      messageTimestamp: Math.floor(Date.now() / 1000),
    },
  };
}

const post = (body: unknown, secret = SECRET, method = 'POST') =>
  new Request('https://fn.test/whatsapp-webhook', {
    method,
    headers: { 'x-sofia-secret': secret, 'Content-Type': 'application/json' },
    body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });

const text = (phone: string, body: string, key?: Record<string, unknown>) => payload(phone, { conversation: body }, key);

const lastUserText = (client: FakeClient, request = -1) => {
  const messages = client.requests.at(request)!.messages;
  return contentText(messages.filter((m) => m.role === 'user').at(-1)!);
};

/** Parágrafos longos o bastante para virarem duas mensagens (os curtos são juntados). */
const PARTS = ['Que alegria receber sua coruja por aqui!', 'A festa será no Cerimonial Casa de Pedra Slim.'];
const TWO_PARTS = PARTS.join('\n\n');

const pendingCount = async () =>
  (await t.db.query<{ n: number }>('select count(*)::int as n from public.wa_inbox where processed_at is null')).rows[0]!.n;

describe('webhook', () => {
  it('grava, responde 200 na hora e processa em segundo plano: lida, "digitando…" e resposta', async () => {
    const s = setup({ client: new FakeClient(say('Olá, Carlos! ✨ A coruja chegou.')) });
    const response = await s.webhook(post(text(carlos, 'Oi, Aifos!')));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, queued: true });
    await s.settle();

    expect(s.whatsapp.events).toEqual([
      { type: 'read', to: `${carlos}@s.whatsapp.net`, value: `WA${seq}` },
      { type: 'text', to: carlos, value: 'Olá, Carlos! ✨ A coruja chegou.', typingMs: 'Olá, Carlos! ✨ A coruja chegou.'.length },
    ]);
    expect(lastUserText(s.client)).toBe('Oi, Aifos!');
    expect(await pendingCount()).toBe(0);
  });

  it('o mesmo evento duas vezes (reenvio da Evolution) gera uma resposta só', async () => {
    const s = setup({ client: new FakeClient(say('Oi!')) });
    const event = text(carlos, 'Oi');
    await s.webhook(post(event));
    const again = await s.webhook(post(event));
    expect(await again.json()).toEqual({ ok: true, queued: false });
    await s.settle();
    expect(s.jobs).toHaveLength(1);
    expect(s.whatsapp.texts()).toEqual(['Oi!']);
  });

  it('autenticação, método, JSON e eventos ignorados', async () => {
    const s = setup();
    expect((await s.webhook(post(text(carlos, 'Oi'), 'x'.repeat(40)))).status).toBe(401);
    expect((await s.webhook(post(text(carlos, 'Oi'), ''))).status).toBe(401);
    expect((await s.webhook(post(null, SECRET, 'GET'))).status).toBe(405);
    expect((await s.webhook(post('{não é json'))).status).toBe(400);
    const own = await s.webhook(post(text(carlos, 'Oi', { fromMe: true })));
    expect(await own.json()).toEqual({ ok: true, ignored: 'from_me' });
    const group = await s.webhook(post(text(carlos, 'Oi', { remoteJid: '1203630@g.us' })));
    expect(await group.json()).toEqual({ ok: true, ignored: 'group_or_broadcast' });
    expect(s.jobs).toHaveLength(0);
    expect(await pendingCount()).toBe(0);
    expect(s.logs.map((l) => l.event)).toEqual(['webhook_unauthorized', 'webhook_unauthorized', 'webhook_ignored']);
  });

  it('recusa subir com segredo curto', () => {
    expect(() =>
      createWebhookHandler({ secret: 'curto', instance: INSTANCE, rpc: t.rpc, bot: { processContact: async () => {} }, background: () => {}, log: () => {} }),
    ).toThrow(/WEBHOOK_SECRET/);
  });

  it('erro no banco devolve 500 (a Evolution tenta de novo)', async () => {
    const failing: Rpc = async () => {
      throw new Error('banco fora do ar');
    };
    const s = setup({ rpc: failing });
    await expect(s.webhook(post(text(carlos, 'Oi')))).rejects.toThrow(/banco fora do ar/);
  });
});

describe('orquestrador', () => {
  it('janela de silêncio: quem escreve em partes recebe uma resposta só; cada parte reinicia a espera', async () => {
    const naps: number[] = [];
    const parts = ['Queria confirmar', 'eu e o Pedro'];
    // Cada "soneca" da Aifos é interrompida por mais uma parte, até a pessoa parar.
    const s = setup({
      client: new FakeClient(say('Respondo tudo de uma vez! 🦉')),
      quietMs: 8_000,
      sleep: async (ms) => {
        naps.push(ms);
        const next = parts.shift();
        if (next) await s.webhook(post(text(carlos, next)));
      },
    });
    await s.webhook(post(text(carlos, 'Oi!')));
    await s.settle();

    expect(naps).toEqual([8_000, 8_000, 8_000]);
    expect(s.client.requests).toHaveLength(1);
    expect(lastUserText(s.client)).toBe('Oi!\nQueria confirmar\neu e o Pedro');
    expect(s.whatsapp.events.filter((e) => e.type === 'read')).toHaveLength(1);
    expect(s.whatsapp.texts()).toEqual(['Respondo tudo de uma vez! 🦉']);
  });

  it('janela de silêncio tem teto: quem não para de escrever é respondido mesmo assim', async () => {
    const naps: number[] = [];
    const s = setup({
      client: new FakeClient(say('Calma, jovem bruxo! 🦉')),
      quietMs: 8_000,
      maxGatherMs: 20_000,
      sleep: async (ms) => {
        naps.push(ms);
        await s.webhook(post(text(carlos, `parte ${naps.length}`)));
      },
    });
    await s.webhook(post(text(carlos, 'Oi!')));
    await s.settle();

    expect(naps).toEqual([8_000, 8_000, 4_000]);
    expect(s.client.requests).toHaveLength(1);
    expect(lastUserText(s.client)).toBe('Oi!\nparte 1\nparte 2\nparte 3');
  });

  it('mensagem que chega durante o processamento é respondida na rodada seguinte', async () => {
    const s = setup();
    const { client } = s;
    client.then(
      () => {
        // Enquanto o modelo "pensa", chega outra mensagem: outra execução não pega a trava.
        void s.webhook(post(text(carlos, 'Ah, e o horário?')));
        return say('Anotado!');
      },
      say('A festa começa às 20h.'),
    );
    await s.webhook(post(text(carlos, 'Vamos sim!')));
    await s.settle();
    await new Promise((r) => setTimeout(r, 0));
    await s.settle();

    expect(client.requests).toHaveLength(2);
    expect(lastUserText(client, 1)).toBe('Ah, e o horário?');
    expect(s.whatsapp.texts()).toEqual(['Anotado!', 'A festa começa às 20h.']);
    expect(await pendingCount()).toBe(0);
  });

  it('confirmação reage com ❤️ na mensagem certa (conversa @lid), antes da resposta', async () => {
    const carlosId = await t.guestId('Carlos Souza');
    const client = new FakeClient(
      call('registrar_resposta', { respostas: [{ convidado_id: carlosId, presenca: 'sim' }] }),
      say('Feitiço lançado! ✨ O nome do Carlos já brilha no pergaminho.\n\nNos vemos na noite mais mágica do ano!'),
    );
    const s = setup({ client });
    const lid = '138012345678915@lid';
    await s.webhook(post(text(lid.replace('@lid', ''), 'Confirmo!', { remoteJid: lid, remoteJidAlt: `${carlos}@s.whatsapp.net` })));
    await s.settle();

    expect(await t.statusOf('Carlos Souza')).toBe('attending');
    expect(s.whatsapp.events.map((e) => e.type)).toEqual(['read', 'reaction', 'text', 'text']);
    expect(s.whatsapp.events[1]).toEqual({ type: 'reaction', to: lid, value: `WA${seq} ❤️` });
    expect(s.whatsapp.texts(carlos)).toEqual([
      'Feitiço lançado! ✨ O nome do Carlos já brilha no pergaminho.',
      'Nos vemos na noite mais mágica do ano!',
    ]);
  });

  it('áudio: transcrito; longo demais não é baixado; falha vira aviso ao modelo', async () => {
    const client = new FakeClient(say('Que bom!'), say('Pode resumir?'), say('Não consegui ouvir.'), say('Escreva, por favor.'));
    const s = setup({ client });
    const audio = (seconds: number) => payload(carlos, { audioMessage: { seconds, ptt: true } });

    await s.webhook(post(audio(8)));
    await s.settle();
    expect(lastUserText(client)).toBe('[áudio transcrito] Vou sim, com certeza!');

    await s.webhook(post(audio(300)));
    await s.settle();
    expect(lastUserText(client)).toContain('áudio longo demais');
    expect(s.whatsapp.events.filter((e) => e.type === 'download')).toHaveLength(1);

    const broken = setup({ client, transcriber: { transcribe: async () => Promise.reject(new Error('OpenAI 500')) } });
    await broken.webhook(post(audio(5)));
    await broken.settle();
    expect(lastUserText(client)).toBe('[enviou um áudio que não pôde ser transcrito]');
    expect(broken.logs.some((l) => l.event === 'transcription_failed')).toBe(true);

    const none = setup({ client, transcriber: null });
    await none.webhook(post(audio(5)));
    await none.settle();
    expect(lastUserText(client)).toBe('[enviou um áudio que não pôde ser transcrito]');
    expect(none.whatsapp.events.filter((e) => e.type === 'download')).toHaveLength(0);
  });

  it('"relatório" do organizador sai do banco, sem IA; de outra pessoa vai para a Aifos', async () => {
    const client = new FakeClient(say('Esse pergaminho é só da família! 🦉'));
    const s = setup({ client });
    await s.webhook(post(text(marta, 'Relatório')));
    await s.settle();
    expect(client.requests).toHaveLength(0);
    const report = s.whatsapp.texts(marta);
    expect(report[0]).toContain('📜 *Relatório da Professora Aifos*');
    expect(report[0]).toContain('⏳ Sem resposta: *7*');
    expect(report.at(-1)).toContain('• *Família Souza*: Carlos Souza, Marta Souza, Bia Souza (menor), Pedro Souza (menor)');

    await s.webhook(post(text(carlos, 'relatório')));
    await s.settle();
    expect(client.requests).toHaveLength(1);
    expect(s.whatsapp.texts(carlos)).toEqual(['Esse pergaminho é só da família! 🦉']);
  });

  it('"recados" do organizador lista os recados para a Sofia, sem IA; de outra pessoa vai para a Aifos', async () => {
    const client = new FakeClient(say('Os recados são surpresa! 🦉'));
    const s = setup({ client });
    await s.webhook(post(text(marta, 'recados')));
    await s.settle();
    expect(s.whatsapp.texts(marta)).toEqual(['💌 Ainda não chegou nenhum recado para a Sofia.']);

    await t.rpc('bot_save_guest_message', {
      p_phone: carlos,
      p_body: 'Sofia, você é a nossa estrela!',
      p_signature: 'Tio Carlos',
      p_source: 'audio',
      p_wa_message_id: null,
    });
    await s.webhook(post(text(marta, 'Recados!')));
    await s.settle();
    expect(client.requests).toHaveLength(0);
    const [msg] = s.whatsapp.texts(marta).slice(1);
    expect(msg).toMatch(
      /^💌 \*Recados para a Sofia\* \(1\)\n\n\*#(\d+) · Carlos Souza\* \(Família Souza · assinado "Tio Carlos" · por áudio 🎙️ · \d\d\/\d\d\) ⏳ aguardando\nSofia, você é a nossa estrela!\n\n🕯️ \*Salão do site\*: 0 pendurado\(s\), 1 aguardando\.\nPara pendurar: \*publicar \1\*\. Para tirar: \*retirar \1\*\.$/,
    );

    await s.webhook(post(text(carlos, 'recados')));
    await s.settle();
    expect(client.requests).toHaveLength(1);
    expect(s.whatsapp.texts(carlos)).toEqual(['Os recados são surpresa! 🦉']);
  });

  it('"presentes" do organizador mostra quem deu cada presente, sem IA; de outra pessoa vai para a Aifos', async () => {
    const client = new FakeClient(say('Os presentes são surpresa! 🦉'));
    const s = setup({ client });
    await t.db.exec('truncate public.gift_orders');
    await s.webhook(post(text(marta, 'presentes')));
    await s.settle();
    expect(s.whatsapp.texts(marta)).toEqual(['🎁 Ainda nenhum presente pago pela lista do site.']);

    await t.rpc('bot_create_gift_order', {
      p_gift_id: 'fone', p_gift_name: 'Fone Bluetooth', p_kind: 'quota', p_payment_method: 'pix', p_base_cents: 27_300,
      p_charged_cents: 27_499, p_message: 'Parabéns!', p_signature: null, p_anonymous: true, p_ip_hash: null,
    });
    await t.db.exec(`update public.gift_orders set status = 'paid', paid_at = now(), asaas_checkout_id = 'chk_bot'`);
    await t.rpc('bot_set_gift_payer', { p_checkout_id: 'chk_bot', p_payer_name: 'Maria Souza' });
    await s.webhook(post(text(marta, 'Presentes!')));
    await s.settle();
    expect(client.requests).toHaveLength(0);
    expect(s.whatsapp.texts(marta).at(-1)).toMatch(
      /^🎁 \*Presentes pela lista\* \(1 pago · R\$ 273,00 para a família\)\n_Só os organizadores veem os nomes\._\n\n\*Fone Bluetooth\* \(R\$ 273,00 · Pix · \d\d\/\d\d\)\nDe: Maria Souza\n💌 recado em segredo$/,
    );

    await s.webhook(post(text(carlos, 'presentes')));
    await s.settle();
    expect(client.requests).toHaveLength(1);
    expect(s.whatsapp.texts(carlos)).toEqual(['Os presentes são surpresa! 🦉']);
    expect(JSON.stringify(client.requests)).not.toContain('Maria Souza');
  });

  it('"publicar N" / "retirar N" do organizador penduram e tiram a carta do Salão; de convidado vai para a Aifos', async () => {
    const client = new FakeClient(say('Isso é com a família! 🦉'));
    const s = setup({ client });
    await t.rpc('bot_save_guest_message', {
      p_phone: carlos,
      p_body: 'Sofia, você é a nossa estrela!',
      p_signature: 'Tio Carlos',
      p_source: 'text',
      p_wa_message_id: null,
    });
    const [entry] = (await t.rpc('bot_guest_messages', {})) as { id: number }[];
    const id = entry!.id;
    const wall = async () => ((await t.rpc('bot_site_messages', {})) as { letters: unknown[] }).letters;

    await s.webhook(post(text(marta, `Publicar #${id}`)));
    await s.settle();
    expect(s.whatsapp.texts(marta)).toEqual([`🕯️ Carta #${id} (de Tio Carlos) pendurada no Salão do site. Ela aparece em até 1 minuto.`]);
    expect(await wall()).toHaveLength(1);

    await s.webhook(post(text(marta, `retirar ${id}`)));
    await s.settle();
    expect(s.whatsapp.texts(marta).at(-1)).toBe(`Carta #${id} (de Tio Carlos) retirada do Salão do site.`);
    expect(await wall()).toHaveLength(0);

    await s.webhook(post(text(marta, 'publicar 999999')));
    await s.settle();
    expect(s.whatsapp.texts(marta).at(-1)).toBe('Não encontrei o recado #999999. Mande *recados* para ver os números.');
    expect(client.requests).toHaveLength(0);

    await s.webhook(post(text(carlos, `publicar ${id}`)));
    await s.settle();
    expect(client.requests).toHaveLength(1);
    expect(await wall()).toHaveLength(0);
  });

  it('número errado na lista: aviso numerado aos organizadores; "aceitar N" troca o telefone e avisa a pessoa', async () => {
    const client = new FakeClient(
      call('buscar_convidado', { nome_completo: 'Carlos Souza' }),
      say('Pedi à família para confirmar este número! 🦉'),
      say('Isso é com os organizadores.'), // "aceitar N" vindo de convidado vai para a Aifos
    );
    const s = setup({ client, adminPhones: [marta, joao] });
    await s.webhook(post(text(desconhecido, 'Oi! Sou o Carlos Souza, troquei de número.')));
    await s.settle();

    const id = ((await t.rpc('bot_identity_request_status', { p_phone: desconhecido })) as { id: number }).id;
    const alert = [
      `⚠️ *Pedido #${id} da Professora Aifos*`,
      'O número +55 11 91234-5678 ("Convidado" no WhatsApp) disse ser *Carlos Souza*.',
      'Na lista, *Carlos Souza* (Família Souza) tem outro telefone: +55 31 98888-7777.',
      '',
      `Se for essa pessoa, o número novo substitui o da lista: *aceitar ${id}*`,
      `Se não for: *recusar ${id}*`,
    ].join('\n');
    expect(s.whatsapp.texts(marta)).toEqual([alert]);
    expect(s.whatsapp.texts(joao)).toEqual([alert]);
    expect(s.whatsapp.texts(desconhecido)).toEqual(['Pedi à família para confirmar este número! 🦉']);

    // Só organizador decide: de um convidado, "aceitar N" é conversa comum.
    await s.webhook(post(text(carlos, `aceitar ${id}`)));
    await s.settle();
    expect(client.requests).toHaveLength(3);
    expect((await t.rpc('bot_identity_request_status', { p_phone: desconhecido })) as { status: string }).toMatchObject({
      status: 'pending',
    });

    await s.webhook(post(text(marta, `Aceito o pedido #${id}.`)));
    await s.settle();
    const decided =
      `✅ Pedido #${id} aceito (por +55 31 97777-6666): +55 11 91234-5678 agora é *Carlos Souza* (Família Souza). ` +
      'O telefone antigo da lista (+55 31 98888-7777) foi substituído. Já avisei a pessoa.';
    expect(s.whatsapp.texts(desconhecido).at(-1)).toBe(IDENTITY_REPLIES.accepted('Carlos'));
    expect(s.whatsapp.texts(marta).at(-1)).toBe(decided);
    expect(s.whatsapp.texts(joao).at(-1)).toBe(decided);
    expect(client.requests).toHaveLength(3); // sem IA

    // O outro organizador tenta decidir de novo: só ele recebe a resposta.
    await s.webhook(post(text(joao, `recusar ${id}`)));
    await s.settle();
    expect(s.whatsapp.texts(joao).at(-1)).toBe(`O pedido #${id} já foi aceito (Carlos Souza).`);
    expect(s.whatsapp.texts(marta).at(-1)).toBe(decided);

    const card = (await t.rpc('bot_contact_card', { p_phone: desconhecido })) as { guest_name: string; verified_by: string };
    expect(card).toMatchObject({ guest_name: 'Carlos Souza', verified_by: 'phone' });
  });

  it('nome não encontrado: "aceitar N Nome" escolhe o convidado; "recusar N" orienta a pessoa', async () => {
    const client = new FakeClient(
      call('pedir_confirmacao_da_familia', { nome_informado: 'Jô Barbosa' }),
      say('Pedi à família para confirmar! 🦉'),
    );
    const s = setup({ client, adminPhones: [marta] });
    await s.webhook(post(text(desconhecido, 'Sou a Jô Barbosa, fui convidada sim!')));
    await s.settle();
    const id = ((await t.rpc('bot_identity_request_status', { p_phone: desconhecido })) as { id: number }).id;
    expect(s.whatsapp.texts(marta)).toEqual([
      [
        `⚠️ *Pedido #${id} da Professora Aifos*`,
        'O número +55 11 91234-5678 ("Convidado" no WhatsApp) disse se chamar *Jô Barbosa*, mas não encontrei esse nome na lista de convidados.',
        '',
        'Nomes parecidos na lista (mande a linha da pessoa certa):',
        `• *aceitar ${id} Joana Barbosa* (Família Barbosa)`,
        `• *aceitar ${id} João Carlos Barbosa* (Família Barbosa)`,
        '',
        `Se for outro convidado, mande o nome como está na lista: *aceitar ${id} Nome Sobrenome*`,
        `Se não for: *recusar ${id}*`,
      ].join('\n'),
    ]);

    await s.webhook(post(text(marta, `aceitar ${id}`)));
    await s.settle();
    expect(s.whatsapp.texts(marta).at(-1)).toBe(
      [
        `Para aceitar o pedido #${id}, mande o nome do convidado como está na lista: *aceitar ${id} Nome Sobrenome*`,
        '',
        'Nomes parecidos na lista:',
        `• *aceitar ${id} Joana Barbosa* (Família Barbosa)`,
        `• *aceitar ${id} João Carlos Barbosa* (Família Barbosa)`,
      ].join('\n'),
    );
    await s.webhook(post(text(marta, `aceitar ${id} Fulano Inexistente`)));
    await s.settle();
    // Nada parecido na lista: só a orientação.
    expect(s.whatsapp.texts(marta).at(-1)).toBe(
      `Não encontrei "Fulano Inexistente" na lista. Confira o nome e mande de novo: *aceitar ${id} Nome Sobrenome*`,
    );
    await s.webhook(post(text(marta, `aceitar ${id} Jô Barbosa`)));
    await s.settle();
    expect(s.whatsapp.texts(marta).at(-1)).toMatch(
      new RegExp(`\\n\\nNomes parecidos na lista:\\n• \\*aceitar ${id} Joana Barbosa\\* \\(Família Barbosa\\)\\n`),
    );
    expect(s.whatsapp.texts(desconhecido)).toHaveLength(1); // a pessoa só é avisada quando há decisão

    await s.webhook(post(text(marta, `aceitar ${id} joana barbosa`)));
    await s.settle();
    expect(s.whatsapp.texts(desconhecido).at(-1)).toBe(IDENTITY_REPLIES.accepted('Joana'));
    expect(s.whatsapp.texts(marta).at(-1)).toBe(
      `✅ Pedido #${id} aceito (por +55 31 97777-6666): +55 11 91234-5678 agora é *Joana Barbosa* (Família Barbosa). Já avisei a pessoa.`,
    );
    expect(client.requests).toHaveLength(2);
  });

  it('"recusar N": a pessoa recebe a orientação fixa e os organizadores, a confirmação', async () => {
    const client = new FakeClient(call('buscar_convidado', { nome_completo: 'Carlos Souza' }), say('Pedi à família! 🦉'));
    const s = setup({ client, adminPhones: [marta, joao] });
    await s.webhook(post(text(desconhecido, 'Sou o Carlos Souza.')));
    await s.settle();
    const id = ((await t.rpc('bot_identity_request_status', { p_phone: desconhecido })) as { id: number }).id;
    await s.webhook(post(text(joao, `recusar ${id}`)));
    await s.settle();
    const decided = `🚫 Pedido #${id} recusado (por +55 21 99999-0000). Avisei o número +55 11 91234-5678 para falar diretamente com a família.`;
    expect(s.whatsapp.texts(desconhecido).at(-1)).toBe(IDENTITY_REPLIES.rejected);
    expect(s.whatsapp.texts(joao).at(-1)).toBe(decided);
    expect(s.whatsapp.texts(marta).at(-1)).toBe(decided);
    const card = (await t.rpc('bot_contact_card', { p_phone: desconhecido })) as { guest_name: string | null };
    expect(card.guest_name).toBeNull();
  });

  it('organizador com "relatório" e outra mensagem: relatório e conversa', async () => {
    const client = new FakeClient(say('Oi, Marta!'));
    const s = setup({ client, quietMs: 20 });
    await s.webhook(post(text(marta, 'relatorio')));
    await s.webhook(post(text(marta, 'E o traje?')));
    await s.settle();
    expect(lastUserText(client)).toBe('E o traje?');
    expect(s.whatsapp.texts(marta).at(-1)).toBe('Oi, Marta!');
    expect(s.whatsapp.texts(marta)[0]).toContain('Relatório');
  });

  it('pais (organizadores) e equipe conversam como não convidados; comando sozinho não muda nada', async () => {
    const client = new FakeClient(say('Olá!'), say('Olá!'));
    const s = setup({ client, staffPhones: [desconhecido] });
    await s.webhook(post(text(marta, 'relatorio')));
    await s.settle();
    expect((await t.repo.householdStatus(marta)) as { role?: string }).toMatchObject({ role: 'guest' });

    await s.webhook(post(text(marta, 'Oi, Aifos!')));
    await s.webhook(post(text(desconhecido, 'Boa tarde!')));
    await s.settle();
    expect((await t.repo.householdStatus(marta)) as { role?: string }).toMatchObject({ role: 'host' });
    expect((await t.repo.householdStatus(desconhecido)) as { role?: string }).toMatchObject({ role: 'staff' });
    const contexts = client.requests.map((r) => contentText(r.messages.at(-1)!)).join('\n');
    expect(contexts).toContain('mãe da Sofia (organizador da festa)');
    expect(contexts).toContain('da equipe da festa (cerimonial)');
  });

  it('avisos da Aifos chegam aos organizadores com quem é o contato', async () => {
    const client = new FakeClient(
      call('encaminhar_para_familia', { motivo: 'Carlos pergunta se a avó pode ir de cadeira de rodas.' }),
      say('Já mandei uma coruja para a família! 🦉'),
    );
    const s = setup({ client, adminPhones: [marta, joao] });
    await s.webhook(post(text(carlos, 'A vovó vai de cadeira de rodas, tem acesso?')));
    await s.settle();

    const forward = [
      '🦉 *Aviso da Professora Aifos*',
      'De: Carlos Souza (Família Souza)',
      'WhatsApp: +55 31 98888-7777',
      '',
      'Carlos pergunta se a avó pode ir de cadeira de rodas.',
    ].join('\n');
    expect(s.whatsapp.texts(marta)).toEqual([forward]);
    expect(s.whatsapp.texts(joao)).toEqual([forward]);
    expect(s.whatsapp.texts(carlos)).toEqual(['Já mandei uma coruja para a família! 🦉']);
  });

  it('falha inesperada: baixa a fila e pede para reenviar (sem repetir em loop)', async () => {
    const failing: Rpc = async (fn, args) => {
      if (fn === 'bot_consume_turn') throw new Error('timeout do banco');
      return t.rpc(fn, args);
    };
    const s = setup({ rpc: failing });
    await s.webhook(post(text(carlos, 'Oi')));
    await s.settle();
    expect(s.whatsapp.texts(carlos)).toEqual([FIXED_REPLIES.error]);
    expect(await pendingCount()).toBe(0);
    expect(s.logs.find((l) => l.event === 'turn_failed')?.data).toMatchObject({ phone: '…7777' });
  });

  it('falha no envio não derruba a entrega nem deixa a fila presa', async () => {
    const s = setup({ client: new FakeClient(say(TWO_PARTS)) });
    s.whatsapp.failSends = 1;
    await s.webhook(post(text(carlos, 'Oi')));
    await s.settle();
    expect(s.logs.some((l) => l.event === 'send_failed')).toBe(true);
    expect(await pendingCount()).toBe(0);
    const lease = await t.db.query<{ lease_until: string | null }>('select lease_until from public.wa_contacts where phone = $1', [carlos]);
    expect(lease.rows[0]!.lease_until).toBeNull();
    expect(s.logs.find((l) => l.event === 'delivered')?.data).toMatchObject({ replies: 2, sent: 0 });
  });

  it('Evolution reconectando ("Connection Closed"): espera, tenta de novo e entrega tudo', async () => {
    const sleeps: number[] = [];
    const s = setup({ client: new FakeClient(say(TWO_PARTS)), sleep: async (ms) => void sleeps.push(ms) });
    s.whatsapp.failSends = 2;
    s.whatsapp.sendError = new EvolutionError('/message/sendText', 400, '{"response":{"message":["Error: Connection Closed"]}}');
    await s.webhook(post(text(carlos, 'Oi')));
    await s.settle();
    expect(s.whatsapp.texts(carlos)).toEqual(PARTS);
    expect(sleeps).toEqual([5, 15]);
    expect(s.logs.filter((l) => l.event === 'send_retry').map((l) => l.data?.retry)).toEqual([1, 2]);
    expect(s.logs.some((l) => l.event === 'send_failed')).toBe(false);
    expect(s.logs.find((l) => l.event === 'delivered')?.data).toMatchObject({ replies: 2, sent: 2 });
  });

  it('falha passageira que não passa: desiste depois das tentativas, sem mandar as partes seguintes', async () => {
    const s = setup({ client: new FakeClient(say(TWO_PARTS)), sleep: async () => {} });
    s.whatsapp.failSends = 99;
    s.whatsapp.sendError = new EvolutionError('/message/sendText', 503, 'indisponível');
    await s.webhook(post(text(carlos, 'Oi')));
    await s.settle();
    expect(s.whatsapp.sendAttempts).toBe(3);
    expect(s.logs.filter((l) => l.event === 'send_failed')).toHaveLength(1);
    expect(s.logs.find((l) => l.event === 'delivered')?.data).toMatchObject({ sent: 0 });
  });

  it('timeout no envio não é repetido (a mensagem pode ter saído)', async () => {
    const s = setup({ client: new FakeClient(say('Olá!')), sleep: async () => {} });
    s.whatsapp.failSends = 1;
    s.whatsapp.sendError = new DOMException('Signal timed out.', 'TimeoutError');
    await s.webhook(post(text(carlos, 'Oi')));
    await s.settle();
    expect(s.whatsapp.sendAttempts).toBe(1);
    expect(s.logs.some((l) => l.event === 'send_retry')).toBe(false);
    expect(s.logs.some((l) => l.event === 'send_failed')).toBe(true);
  });
});

describe('cron', () => {
  it('tick: reprocessa mensagem esquecida na fila (execução que caiu)', async () => {
    const s = setup({ client: new FakeClient(say('Desculpe a demora! 🦉')), clock: new Date('2026-11-10T02:00:00Z') });
    await t.rpc('bot_inbox_add', { p_wa_message_id: 'perdida', p_phone: carlos, p_push_name: 'Carlos', p_kind: 'text', p_body: 'Oi?' });
    expect(await s.bot.tick()).toEqual({ stalled: 0, followUps: 0 }); // recente demais
    await t.db.exec(`update public.wa_inbox set received_at = now() - interval '10 minutes'`);
    expect(await s.bot.tick()).toEqual({ stalled: 1, followUps: 0 }); // 23h: sem retomadas
    expect(s.whatsapp.texts(carlos)).toEqual(['Desculpe a demora! 🦉']);
  });

  it('tick: retoma conversa parada no horário permitido', async () => {
    const client = new FakeClient(say('Confirmo a presença do Carlos e do Pedro?'), say('Ainda está aí? A coruja espera sua resposta. 🦉'));
    const s = setup({ client, clock: MORNING });
    await s.webhook(post(text(carlos, 'Vamos eu e o Pedro')));
    await s.settle();
    await t.db.exec(`update public.wa_sessions set last_message_at = last_message_at - interval '4 hours'`);

    expect(await s.bot.tick()).toEqual({ stalled: 0, followUps: 1 });
    expect(s.whatsapp.texts(carlos).at(-1)).toBe('Ainda está aí? A coruja espera sua resposta. 🦉');
    expect(await s.bot.tick()).toEqual({ stalled: 0, followUps: 0 }); // uma vez só
  });

  it('relatório diário vai aos organizadores até o dia da festa', async () => {
    const s = setup({ adminPhones: [marta, joao] });
    expect(await s.bot.dailyReport()).toBe(true);
    expect(s.whatsapp.texts(marta)[0]).toContain('🦉 *Relatório diário da Professora Aifos*');
    expect(s.whatsapp.texts(joao)).toEqual(s.whatsapp.texts(marta));

    const after = setup({ clock: new Date('2027-03-01T12:00:00Z') });
    expect(await after.bot.dailyReport()).toBe(false);
    expect(await setup({ adminPhones: [] }).bot.dailyReport()).toBe(false);

    // Lista ainda não importada: nada de relatório com zero convidados.
    await t.db.exec('truncate public.households cascade');
    const empty = setup();
    expect(await empty.bot.dailyReport()).toBe(false);
    expect(empty.whatsapp.texts()).toEqual([]);
  });

  it('handler: segredo conferido no banco; jobs conhecidos rodam em segundo plano', async () => {
    const ran: string[] = [];
    const bot = { tick: async () => ran.push('tick'), dailyReport: async () => ran.push('daily-report') } as never;
    const req = (job: unknown, secret = 'c'.repeat(64)) =>
      new Request('https://fn.test/whatsapp-cron', { method: 'POST', headers: { 'x-cron-secret': secret }, body: JSON.stringify({ job }) });

    // PGlite não tem Vault: nenhum segredo vale.
    const real = createCronHandler({ rpc: t.rpc, bot, background: () => {}, log: () => {} });
    expect((await real(req('tick'))).status).toBe(401);

    const jobs: Promise<unknown>[] = [];
    const trusting: Rpc = async (fn, args) => (fn === 'bot_cron_secret_ok' ? args.p_secret === 'c'.repeat(64) : null);
    const handler = createCronHandler({ rpc: trusting, bot, background: (p) => jobs.push(p), log: () => {} });
    expect((await handler(req('tick', 'errado'))).status).toBe(401);
    expect((await handler(req('tick'))).status).toBe(202);
    expect((await handler(req('daily-report'))).status).toBe(202);
    expect((await handler(req('apagar-tudo'))).status).toBe(400);
    await Promise.all(jobs);
    expect(ran).toEqual(['tick', 'daily-report']);
  });
});

describe('SQL do canal', () => {
  const asRole = async (role: string, sql: string) => {
    try {
      await t.db.transaction(async (tx) => {
        await tx.exec(`set local role ${role}`);
        await tx.exec(sql);
      });
      return 'ok';
    } catch (error) {
      return String(error);
    }
  };

  it('fila guarda o JID; cartão do contato; varredura respeita idade e trava', async () => {
    await t.rpc('bot_inbox_add', {
      p_wa_message_id: 'm1',
      p_phone: carlos,
      p_push_name: 'Carlão',
      p_kind: 'text',
      p_body: 'Oi',
      p_remote_jid: '138@lid',
    });
    const [row] = (await t.rpc('bot_inbox_pending', { p_phone: carlos })) as { remote_jid: string }[];
    expect(row!.remote_jid).toBe('138@lid');

    expect(await t.rpc('bot_contact_card', { p_phone: carlos })).toEqual({
      phone: carlos,
      display_name: 'Carlão',
      guest_name: 'Carlos Souza',
      household: 'Família Souza',
      verified_by: 'phone',
    });
    expect(await t.rpc('bot_contact_card', { p_phone: '5511900000000' })).toMatchObject({ guest_name: null, display_name: null });

    const stalled = () => t.rpc('bot_inbox_stalled', { p_min_age_seconds: 180, p_limit: 10 });
    expect(await stalled()).toEqual([]);
    await t.db.exec(`update public.wa_inbox set received_at = now() - interval '5 minutes'`);
    expect(await stalled()).toEqual([carlos]);
    await t.rpc('bot_claim_contact', { p_phone: carlos, p_lease_seconds: 60 });
    expect(await stalled()).toEqual([]);
  });

  it('sem Vault, nenhum segredo de cron vale', async () => {
    expect(await t.rpc('bot_cron_secret_ok', { p_secret: 'x'.repeat(64) })).toBe(false);
    expect(await t.rpc('bot_cron_secret_ok', { p_secret: 'curto' })).toBe(false);
  });

  it('anon e authenticated não executam as funções novas; ninguém além do dono chama o cron', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const sql of [
        `select public.bot_inbox_add('x', '5531988887777', null, 'text', 'oi', null, null)`,
        `select public.bot_contact_card('5531988887777')`,
        `select public.bot_inbox_stalled(0, 10)`,
        `select public.bot_cron_secret_ok('x')`,
      ]) {
        expect(await asRole(role, sql)).toMatch(/permission denied/);
      }
    }
    expect(await asRole('service_role', `select public.bot_cron_call('tick')`)).toMatch(/permission denied/);
    expect(await asRole('postgres', `select public.bot_cron_call('apagar')`)).toMatch(/invalid_job/);
  });
});

/** Serviço do Profeta falso: guarda as chamadas e responde o que o teste mandar. */
class FakeProfeta implements ProfetaClient {
  readonly sends: { waMessageId: string; author: string; caption: string | null }[] = [];
  readonly removals: { n: number; removed: boolean }[] = [];
  next: (waMessageId: string) => ProfetaSendResult = () => ({ ok: true, n: this.sends.length, tipo: 'foto' });
  async sendFromWhatsApp(input: { waMessageId: string; author: string; caption: string | null }) {
    this.sends.push(input);
    return this.next(input.waMessageId);
  }
  async summary(): Promise<ProfetaSummary> {
    return {
      total: 2,
      fotos: 1,
      videos: 0,
      retirados: 1,
      naFila: 0,
      falhas: 0,
      usadoBytes: 1.5 * 1024 ** 3,
      cotaBytes: 9 * 1024 ** 3,
      janela: 'aberta',
      ultimos: [
        { n: 2, tipo: 'foto', autor: 'Carlos Souza', origem: 'whatsapp', em: '2027-02-20T23:10:00Z', retirado: false },
        { n: 1, tipo: 'foto', autor: null, origem: 'site', em: '2027-02-20T23:05:00Z', retirado: true },
      ],
    };
  }
  async setRemoved(n: number, removed: boolean) {
    this.removals.push({ n, removed });
    return n === 99
      ? ({ ok: false, error: 'nao_encontrada' } as const)
      : ({ ok: true, n, tipo: 'foto', autor: 'Carlos Souza', retirada: removed, mudou: true } as const);
  }
}

const PAGE = 'https://convite.example/profeta/';
const image = (phone: string, caption?: string) => payload(phone, { imageMessage: { mimetype: 'image/jpeg', ...(caption ? { caption } : {}) } });
const video = (phone: string) => payload(phone, { videoMessage: { mimetype: 'video/mp4', seconds: 12 } });

describe('O Profeta Diário pela Aifos', () => {
  it('fotos e vídeos de convidado da lista vão para o jornal, com 📸 e uma resposta fixa (sem IA)', async () => {
    const profeta = new FakeProfeta();
    profeta.next = (id) => ({ ok: true, n: profeta.sends.length, tipo: id === videoId ? 'video' : 'foto' });
    const s = setup({ profeta: { client: profeta, pageUrl: PAGE }, quietMs: 20 });
    const first = image(carlos, 'A valsa!');
    const second = image(carlos);
    const clip = video(carlos);
    const videoId = clip.data.key.id;
    for (const p of [first, second, clip]) await s.webhook(post(p));
    await s.settle();

    expect(s.client.requests).toHaveLength(0);
    expect(profeta.sends).toEqual([
      { waMessageId: first.data.key.id, author: 'Carlos Souza', caption: 'A valsa!' },
      { waMessageId: second.data.key.id, author: 'Carlos Souza', caption: null },
      { waMessageId: videoId, author: 'Carlos Souza', caption: null },
    ]);
    expect(s.whatsapp.events.filter((e) => e.type === 'reaction').map((e) => e.value.split(' ')[1])).toEqual(['📸', '📸', '📸']);
    expect(s.whatsapp.texts(carlos)).toEqual([PROFETA_REPLIES.sent(3, 1, PAGE)]);
    expect(await t.rpc('bot_inbox_pending', { p_phone: carlos })).toEqual([]);
  });

  it('quem não está na lista: a foto não vai ao jornal e a Aifos responde como sempre', async () => {
    const profeta = new FakeProfeta();
    const s = setup({ client: new FakeClient(say('Não consigo ver imagens! 🦉')), profeta: { client: profeta, pageUrl: PAGE } });
    await s.webhook(post(image(desconhecido)));
    await s.settle();
    expect(profeta.sends).toEqual([]);
    expect(s.client.requests).toHaveLength(1);
    expect(lastUserText(s.client)).toBe('[enviou uma imagem]');
  });

  it('antes da festa e fora do ar: resposta honesta, sem sucesso falso', async () => {
    const profeta = new FakeProfeta();
    profeta.next = () => ({ ok: false, error: 'janela_antes' });
    const s = setup({ profeta: { client: profeta, pageUrl: PAGE } });
    await s.webhook(post(image(carlos)));
    await s.settle();
    expect(s.whatsapp.texts(carlos)).toEqual([PROFETA_REPLIES.before]);
    expect(s.whatsapp.events.some((e) => e.type === 'reaction')).toBe(false);

    profeta.next = () => ({ ok: false, error: 'indisponivel' });
    await s.webhook(post(video(carlos)));
    await s.settle();
    expect(s.whatsapp.texts(carlos).at(-1)).toBe(PROFETA_REPLIES.failed(PAGE));
    expect(s.client.requests).toHaveLength(0);
  });

  it('foto junto com texto: a foto vai ao jornal e o texto, para a Aifos', async () => {
    const profeta = new FakeProfeta();
    const s = setup({ client: new FakeClient(say('A festa começa às 20h! ✨')), profeta: { client: profeta, pageUrl: PAGE }, quietMs: 5 });
    await s.webhook(post(image(carlos)));
    await s.webhook(post(text(carlos, 'Que horas começa?')));
    await s.settle();
    expect(profeta.sends).toHaveLength(1);
    expect(s.whatsapp.texts(carlos)).toEqual([PROFETA_REPLIES.sent(1, 0, PAGE), 'A festa começa às 20h! ✨']);
    expect(lastUserText(s.client)).toBe('Que horas começa?');
  });

  it('"fotos", "retirar foto N" e "devolver foto N" do organizador, sem IA; de convidado vai para a Aifos', async () => {
    const profeta = new FakeProfeta();
    const s = setup({ client: new FakeClient(say('Isso é com a família! 🦉')), profeta: { client: profeta, pageUrl: PAGE } });
    await s.webhook(post(text(marta, 'Fotos')));
    await s.settle();
    const summary = s.whatsapp.texts(marta)[0]!;
    expect(summary).toContain('📸 *O Profeta Diário* (recebendo fotos)');
    expect(summary).toContain('1 foto e 0 vídeos no jornal · 1 retirado');
    expect(summary).toContain('Espaço: 1,5 GB de 9,0 GB (17%)');
    expect(summary).toContain('Nº 2 · foto de Carlos Souza (WhatsApp');
    expect(summary).toContain('Nº 1 · foto de anônimo (site');

    await s.webhook(post(text(marta, 'retirar foto 7')));
    await s.settle();
    expect(s.whatsapp.texts(marta).at(-1)).toBe('Foto Nº 7 (de Carlos Souza) retirada do Profeta Diário. Some da página na próxima atualização.');
    await s.webhook(post(text(marta, 'Devolver a foto #7.')));
    await s.settle();
    expect(s.whatsapp.texts(marta).at(-1)).toBe('Foto Nº 7 (de Carlos Souza) de volta ao Profeta Diário.');
    await s.webhook(post(text(marta, 'retirar foto 99')));
    await s.settle();
    expect(s.whatsapp.texts(marta).at(-1)).toBe('Não encontrei a foto Nº 99 no Profeta. Mande *fotos* para ver os números.');
    expect(profeta.removals).toEqual([
      { n: 7, removed: true },
      { n: 7, removed: false },
      { n: 99, removed: true },
    ]);
    expect(s.client.requests).toHaveLength(0);

    await s.webhook(post(text(carlos, 'retirar foto 7')));
    await s.settle();
    expect(profeta.removals).toHaveLength(3);
    expect(s.client.requests).toHaveLength(1);
  });

  it('equipe (cerimonial) modera as fotos sem IA; os outros comandos dela vão para a Aifos', async () => {
    const profeta = new FakeProfeta();
    const parents = 'Isso fica com os pais da Sofia! 🦉';
    const others = ['relatório', 'recados', 'presentes', 'publicar 3', 'retirar 3', 'aceitar 1 Carlos Souza', 'recusar 1'];
    const client = new FakeClient(...others.map(() => say(parents)));
    const s = setup({ client, staffPhones: [desconhecido], profeta: { client: profeta, pageUrl: PAGE } });
    await s.webhook(post(text(desconhecido, 'fotos')));
    await s.settle();
    expect(s.whatsapp.texts(desconhecido)[0]).toContain('📸 *O Profeta Diário*');
    await s.webhook(post(text(desconhecido, 'retirar foto 7')));
    await s.settle();
    expect(s.whatsapp.texts(desconhecido).at(-1)).toBe('Foto Nº 7 (de Carlos Souza) retirada do Profeta Diário. Some da página na próxima atualização.');
    await s.webhook(post(text(desconhecido, 'devolver foto 7')));
    await s.settle();
    expect(s.whatsapp.texts(desconhecido).at(-1)).toBe('Foto Nº 7 (de Carlos Souza) de volta ao Profeta Diário.');
    expect(profeta.removals).toEqual([
      { n: 7, removed: true },
      { n: 7, removed: false },
    ]);
    expect(client.requests).toHaveLength(0);

    for (const command of others) {
      await s.webhook(post(text(desconhecido, command)));
      await s.settle();
    }
    expect(s.whatsapp.texts(desconhecido).slice(3)).toEqual(others.map(() => parents));
    expect(client.requests).toHaveLength(others.length);
    expect(profeta.removals).toHaveLength(2);
  });

  it('sem os secrets do Profeta: foto segue para a Aifos e "fotos" avisa que está desligado', async () => {
    const s = setup({ client: new FakeClient(say('Não consigo ver vídeos! 🦉')) });
    await s.webhook(post(video(carlos)));
    await s.settle();
    expect(lastUserText(s.client)).toBe('[enviou um vídeo]');
    await s.webhook(post(text(marta, 'fotos')));
    await s.settle();
    expect(s.whatsapp.texts(marta)).toEqual(['O Profeta Diário ainda não está ligado nas Edge Functions (secrets PROFETA_*).']);
  });
});
