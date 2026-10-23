/**
 * Memória da Aifos: rotação da sessão (silêncio longo ou muitos turnos) com
 * resumo, resumo que falha sem travar a conversa, transcrição para o resumo e
 * isolamento entre contatos.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../supabase/functions/_shared/agent/config.ts';
import { createAgent } from '../supabase/functions/_shared/agent/index.ts';
import { isSessionStale, renderTranscript } from '../supabase/functions/_shared/agent/memory.ts';
import { SUMMARY_PROMPT } from '../supabase/functions/_shared/agent/prompt.ts';
import { TOOL_NAMES } from '../supabase/functions/_shared/agent/tools.ts';
import type { StoredMessage } from '../supabase/functions/_shared/repo.ts';
import { call, contentText, createTestDb, DEMO_PHONES, FakeClient, inbound, say, type TestDb } from './support/agent.ts';

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

/** Simula a passagem do tempo envelhecendo a sessão aberta. */
const ageOpenSession = (phone: string, hours: number) =>
  t.db.query(
    `update public.wa_sessions set last_message_at = last_message_at - make_interval(hours => $2), started_at = started_at - make_interval(hours => $2)
      where phone = $1 and closed_at is null`,
    [phone, hours],
  );

describe('rotação da sessão', () => {
  it('depois de 12 h de silêncio: resume, encerra e a próxima sessão recebe o resumo', async () => {
    const client = new FakeClient(say('O estacionamento é no local.'));
    const agent = createAgent({ repo: t.repo, client });
    await agent.handleTurn({ phone: carlos, messages: [inbound('Tem estacionamento?')] });
    await ageOpenSession(carlos, 13);

    client.then(say('Carlos perguntou sobre estacionamento.'), say('Oi de novo, Carlos!'));
    await agent.handleTurn({ phone: carlos, messages: [inbound('Oi!')] });

    // 1ª chamada do turno: o resumo, com prompt próprio e sem ferramentas.
    const summaryReq = client.requests[1]!;
    expect(summaryReq.system).toBe(SUMMARY_PROMPT);
    expect(summaryReq.tools).toBeUndefined();
    expect(summaryReq.output_config).toEqual({ effort: 'low' });
    const transcript = contentText(summaryReq.messages[0]!);
    expect(transcript).toContain('Convidado: Tem estacionamento?');
    expect(transcript).toContain('Aifos: O estacionamento é no local.');
    expect(transcript).not.toContain('Contexto verificado');

    // 2ª chamada: sessão nova (sem o histórico antigo) e o resumo no contexto.
    const turn = client.requests[2]!;
    expect(turn.messages.map((m) => m.role)).toEqual(['user', 'system']);
    expect(contentText(turn.messages[1]!)).toContain('Conversas anteriores:');
    expect(contentText(turn.messages[1]!)).toContain('"Carlos perguntou sobre estacionamento."');
    expect(contentText(turn.messages[1]!)).toContain('Primeira conversa com esta pessoa: não');

    const sessions = await t.db.query<{ summary: string | null; closed: boolean }>(
      'select summary, closed_at is not null as closed from public.wa_sessions where phone = $1 order by started_at',
      [carlos],
    );
    expect(sessions.rows).toEqual([
      { summary: 'Carlos perguntou sobre estacionamento.', closed: true },
      { summary: null, closed: false },
    ]);
  });

  it('sessão com turnos demais também é encerrada', async () => {
    const client = new FakeClient(say('Oi!'));
    const agent = createAgent({ repo: t.repo, client, config: { sessionMaxTurns: 2 } });
    await agent.handleTurn({ phone: carlos, messages: [inbound('1')] });
    client.then(say('Oi!'));
    await agent.handleTurn({ phone: carlos, messages: [inbound('2')] });
    client.then(say('Resumo.'), say('Oi!'));
    await agent.handleTurn({ phone: carlos, messages: [inbound('3')] });

    expect(client.requests[2]!.system).toBe(SUMMARY_PROMPT);
    expect(client.requests[3]!.messages.map((m) => m.role)).toEqual(['user', 'system']);
  });

  it('se o resumo falhar, encerra sem resumo e a conversa segue', async () => {
    const client = new FakeClient(say('Oi!'));
    const events: string[] = [];
    const agent = createAgent({ repo: t.repo, client, log: (e) => events.push(e) });
    await agent.handleTurn({ phone: carlos, messages: [inbound('Oi')] });
    await ageOpenSession(carlos, 24);

    client.then(() => new Error('timeout'), say('Oi de novo!'));
    const r = await agent.handleTurn({ phone: carlos, messages: [inbound('Voltei')] });

    expect(r.replies).toEqual(['Oi de novo!']);
    expect(events).toContain('summary_failed');
    const closed = await t.db.query<{ summary: string | null }>(
      'select summary from public.wa_sessions where phone = $1 and closed_at is not null',
      [carlos],
    );
    expect(closed.rows).toEqual([{ summary: null }]);
  });

  it('a memória é por contato: Marta não recebe notas nem histórico do Carlos', async () => {
    const client = new FakeClient(
      call(TOOL_NAMES.remember, { nota: 'Carlos é vegetariano' }),
      say('Anotado!'),
      say('Oi, Marta!'),
    );
    const agent = createAgent({ repo: t.repo, client });
    await agent.handleTurn({ phone: carlos, messages: [inbound('Sou vegetariano')] });
    await agent.handleTurn({ phone: marta, messages: [inbound('Oi')] });

    const martaReq = client.requests[2]!;
    expect(martaReq.messages.map((m) => m.role)).toEqual(['user', 'system']);
    expect(contentText(martaReq.messages[1]!)).not.toContain('vegetariano');
  });
});

describe('funções puras', () => {
  it('isSessionStale', () => {
    const now = new Date('2026-10-16T12:00:00Z');
    const session = { id: 's', started_at: '', last_message_at: '2026-10-16T01:00:00Z', turns: 3, messages: [] };
    expect(isSessionStale(session, now, DEFAULT_CONFIG)).toBe(false);
    expect(isSessionStale({ ...session, last_message_at: '2026-10-15T23:00:00Z' }, now, DEFAULT_CONFIG)).toBe(true);
    expect(isSessionStale({ ...session, turns: 30 }, now, DEFAULT_CONFIG)).toBe(true);
  });

  it('renderTranscript mostra falas e ações, sem contexto nem raciocínio', () => {
    const history: StoredMessage[] = [
      { role: 'user', content: 'Vou sim!' },
      { role: 'system', content: 'Contexto verificado...' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'segredo', signature: 's' },
          { type: 'tool_use', id: 'a', name: 'registrar_resposta', input: { respostas: [] } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: '{"ok":true}' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Confirmado!' }] },
    ];
    expect(renderTranscript(history)).toBe(
      [
        'Convidado: Vou sim!',
        '(ação: registrar_resposta {"respostas":[]})',
        '(resultado: {"ok":true})',
        'Aifos: Confirmado!',
      ].join('\n'),
    );
  });
});
