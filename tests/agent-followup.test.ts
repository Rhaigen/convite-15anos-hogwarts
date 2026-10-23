/**
 * Retomada de conversas paradas: quem é candidato (janela de silêncio, última
 * fala da Aifos, uma vez só até a pessoa responder), o que o modelo recebe, o
 * caso "nada pendente", falhas silenciosas, horário permitido e continuidade da
 * sessão quando a pessoa responde.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAgent } from '../supabase/functions/_shared/agent/index.ts';
import { FOLLOW_UP_NUDGE, NO_FOLLOW_UP } from '../supabase/functions/_shared/agent/prompt.ts';
import { contentText, createTestDb, DEMO_PHONES, FakeClient, inbound, say, type TestDb } from './support/agent.ts';

const { carlos, marta } = DEMO_PHONES;
let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await t.db.close();
});

beforeEach(async () => {
  await t.reset();
  await t.touch(carlos);
  await t.touch(marta);
});

/** Faz o tempo passar para a conversa aberta do contato (como no simulador). */
const age = (phone: string, hours: number) =>
  t.db.query(
    `update public.wa_sessions set last_message_at = last_message_at - make_interval(hours => $2)
      where phone = $1 and closed_at is null`,
    [phone, hours],
  );

const QUESTION = 'Confirmo então a presença do Carlos e do Pedro?';

async function conversationWaiting(client: FakeClient, phone = carlos) {
  const agent = createAgent({ repo: t.repo, client });
  client.then(say(QUESTION));
  await agent.handleTurn({ phone, messages: [inbound('Vamos eu e o Pedro')] });
  // Como o orquestrador faz depois de responder (bot_inbox_done).
  await t.db.exec('update public.wa_inbox set processed_at = now() where processed_at is null');
  return agent;
}

describe('candidatos', () => {
  it('só depois de 3 h de silêncio e antes de 24 h', async () => {
    const agent = await conversationWaiting(new FakeClient());
    expect(await agent.followUpCandidates()).toEqual([]);
    await age(carlos, 4);
    expect(await agent.followUpCandidates()).toEqual([carlos]);
    await age(carlos, 30);
    expect(await agent.followUpCandidates()).toEqual([]);
  });

  it('não retoma se há mensagem nova na fila nem se a conversa está sendo processada', async () => {
    const agent = await conversationWaiting(new FakeClient());
    await age(carlos, 4);
    await t.touch(carlos); // mensagem nova no inbox, ainda não processada
    expect(await agent.followUpCandidates()).toEqual([]);

    await t.db.exec('update public.wa_inbox set processed_at = now()');
    await t.rpc('bot_claim_contact', { p_phone: carlos, p_lease_seconds: 60 });
    expect(await agent.followUpCandidates()).toEqual([]);
  });

  it('uma vez só; volta a valer depois que a pessoa responde', async () => {
    const client = new FakeClient();
    const agent = await conversationWaiting(client);
    await age(carlos, 4);
    client.then(say('Ainda está aí? ✨'));
    await agent.followUp(carlos);
    await age(carlos, 4);
    expect(await agent.followUpCandidates()).toEqual([]);

    client.then(say('Feito!'));
    await agent.handleTurn({ phone: carlos, messages: [inbound('Sim!')] });
    await age(carlos, 4);
    expect(await agent.followUpCandidates()).toEqual([carlos]);
  });
});

describe('followUp', () => {
  it('reenvia o histórico + marcador + contexto com a instrução, sem gastar o teto da pessoa', async () => {
    const client = new FakeClient();
    const agent = await conversationWaiting(client);
    await age(carlos, 5);
    client.then(say('Psiu, Carlos! 🦉 Ficou faltando confirmar: posso registrar você e o Pedro?'));
    const r = await agent.followUp(carlos);

    expect(r.outcome).toBe('replied');
    expect(r.replies).toEqual(['Psiu, Carlos! 🦉 Ficou faltando confirmar: posso registrar você e o Pedro?']);
    expect(r.reaction).toBeNull();

    const req = client.requests[1]!;
    expect(req.messages.map((m) => m.role)).toEqual(['user', 'system', 'assistant', 'user', 'system']);
    expect(req.messages.slice(0, 3)).toEqual(client.requests[0]!.messages.concat([req.messages[2]!]));
    expect(req.messages[3]).toEqual({ role: 'user', content: FOLLOW_UP_NUDGE });
    const ctx = contentText(req.messages[4]!);
    expect(ctx).toContain('Contexto verificado');
    expect(ctx).toContain('Retomada automática: a pessoa está há cerca de 5 horas sem responder');

    const turns = await t.db.query<{ turns_count: number; turns: number }>(
      `select c.turns_count, s.turns from public.wa_contacts c join public.wa_sessions s on s.phone = c.phone
        where c.phone = $1`,
      [carlos],
    );
    expect(turns.rows[0]).toEqual({ turns_count: 1, turns: 1 });
  });

  it('se não há nada pendente, não envia nada', async () => {
    const client = new FakeClient();
    const agent = await conversationWaiting(client);
    await age(carlos, 4);
    client.then(say(NO_FOLLOW_UP));
    const r = await agent.followUp(carlos);
    expect(r.outcome).toBe('no_follow_up');
    expect(r.replies).toEqual([]);
  });

  it('erro do modelo na retomada: silêncio, sem aviso à família, histórico coerente', async () => {
    const client = new FakeClient();
    const agent = await conversationWaiting(client);
    await age(carlos, 4);
    client.then(() => new Error('overloaded'));
    const r = await agent.followUp(carlos);
    expect(r.outcome).toBe('error');
    expect(r.replies).toEqual([]);
    expect(r.forwards).toEqual([]);

    const last = await t.db.query<{ content: unknown }>(
      `select m.content from public.wa_session_messages m join public.wa_sessions s on s.id = m.session_id
        where s.phone = $1 order by m.id desc limit 1`,
      [carlos],
    );
    expect(JSON.stringify(last.rows[0]!.content)).toContain(NO_FOLLOW_UP);
    // Não tenta de novo em loop.
    expect(await agent.followUpCandidates()).toEqual([]);
  });

  it('a resposta da pessoa continua na mesma sessão, mesmo com mais de 12 h desde o início', async () => {
    const client = new FakeClient();
    const agent = await conversationWaiting(client);
    await age(carlos, 13);
    client.then(say('Ainda quer confirmar? 🦉'));
    await agent.followUp(carlos);

    client.then(say('Feitiço lançado! ✨'));
    await agent.handleTurn({ phone: carlos, messages: [inbound('Quero sim')] });
    // Sem chamada de resumo: a última requisição traz a conversa inteira.
    expect(client.requests).toHaveLength(3);
    expect(client.requests[2]!.messages.map((m) => m.role)).toEqual([
      'user', 'system', 'assistant', 'user', 'system', 'assistant', 'user', 'system',
    ]);
  });

  it('sem conversa esperando a pessoa, não chama o modelo', async () => {
    const client = new FakeClient();
    const r = await createAgent({ repo: t.repo, client }).followUp(marta);
    expect(r.outcome).toBe('no_follow_up');
    expect(client.requests).toHaveLength(0);
  });
});

describe('horário', () => {
  const at = (iso: string) => createAgent({ repo: t.repo, client: new FakeClient(), clock: () => new Date(iso) });

  it('só entre 9h e 21h de Brasília e antes da festa', () => {
    expect(at('2026-11-10T11:30:00Z').canFollowUpNow()).toBe(false); // 8h30
    expect(at('2026-11-10T12:00:00Z').canFollowUpNow()).toBe(true); // 9h
    expect(at('2026-11-10T23:59:00Z').canFollowUpNow()).toBe(true); // 20h59
    expect(at('2026-11-11T00:00:00Z').canFollowUpNow()).toBe(false); // 21h
    expect(at('2027-02-21T15:00:00Z').canFollowUpNow()).toBe(false); // depois da festa
  });
});
