/**
 * Turno completo da Professora Aifos com cliente Anthropic falso e o banco real
 * (PGlite): forma da requisição (modelo, raciocínio, cache, contexto como
 * mensagem system), histórico só-acréscimo entre turnos, gravação das respostas
 * com reação, teto de iterações, recusa, erros e tetos diários.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAgent } from '../supabase/functions/_shared/agent/index.ts';
import { splitReply, toWhatsApp } from '../supabase/functions/_shared/agent/format.ts';
import { FIXED_REPLIES, SYSTEM_PROMPT } from '../supabase/functions/_shared/agent/prompt.ts';
import { TOOL_NAMES } from '../supabase/functions/_shared/agent/tools.ts';
import {
  call,
  contentText,
  createTestDb,
  DEMO_PHONES,
  FakeClient,
  inbound,
  reply,
  say,
  thinking,
  toolUse,
  type TestDb,
} from './support/agent.ts';

const { carlos, bia } = DEMO_PHONES;
let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await t.db.close();
});

beforeEach(async () => {
  await t.reset();
  await t.touch(carlos, 'Carlão');
  await t.touch(bia, 'Bia');
});

const agentWith = (client: FakeClient) => createAgent({ repo: t.repo, client });

async function storedRoles(phone: string): Promise<string[]> {
  const r = await t.db.query<{ role: string }>(
    `select m.role from public.wa_session_messages m join public.wa_sessions s on s.id = m.session_id
      where s.phone = $1 order by m.id`,
    [phone],
  );
  return r.rows.map((x) => x.role);
}

describe('requisição ao modelo', () => {
  it('usa o Haiku 5.5 com raciocínio adaptativo, cache e ferramentas estritas', async () => {
    const client = new FakeClient(say('Olá, Carlos!'));
    await agentWith(client).handleTurn({ phone: carlos, messages: [inbound('Oi!')] });

    const req = client.requests[0]!;
    expect(req.model).toBe('claude-haiku-5-5');
    expect(req.thinking).toEqual({ type: 'adaptive' });
    expect(req.output_config).toEqual({ effort: 'medium' });
    expect(req.cache_control).toEqual({ type: 'ephemeral' });
    expect(req.system).toEqual([{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]);
    expect(req.tool_choice).toBeUndefined();
    expect(req).not.toHaveProperty('temperature');

    const tools = req.tools as Anthropic.Tool[];
    expect(tools.map((x) => x.name)).toEqual(Object.values(TOOL_NAMES));
    for (const tool of tools) {
      expect(tool.input_schema).toMatchObject({ type: 'object', additionalProperties: false });
      // Ferramentas sem parâmetros não precisam de strict.
      const noParams: string[] = [TOOL_NAMES.status, TOOL_NAMES.facts, TOOL_NAMES.profeta];
      if (!noParams.includes(tool.name)) expect(tool.strict).toBe(true);
    }
  });

  it('envia a mensagem do convidado seguida do contexto verificado como system', async () => {
    const client = new FakeClient(say('Olá!'));
    await agentWith(client).handleTurn({ phone: carlos, messages: [inbound('Oi, tudo bem?')] });

    const [user, system, ...rest] = client.requests[0]!.messages;
    expect(rest).toEqual([]);
    expect(user).toEqual({ role: 'user', content: 'Oi, tudo bem?' });
    expect(system!.role).toBe('system');
    const ctx = contentText(system!);
    expect(ctx).toContain('Contexto verificado pelo sistema');
    expect(ctx).toContain('Carlos Souza, identificado pelo telefone cadastrado (Família Souza)');
    expect(ctx).toContain(`Pedro Souza, filho, menor de idade: ainda não respondeu; pode responder: sim [id ${await t.guestId('Pedro Souza')}]`);
    expect(ctx).toContain('Primeira conversa com esta pessoa: SIM');
    expect(ctx).toContain('Nome no WhatsApp: "Carlão"');
    expect(ctx).toContain('Confirmações: abertas.');
    // Nada de outras famílias.
    expect(ctx).not.toContain('Barbosa');
    expect(ctx).not.toContain('Lúcia');
  });

  it('reenvia o histórico idêntico no turno seguinte (só acréscimo, com os blocos de raciocínio)', async () => {
    const final1 = say('Ninguém respondeu ainda.');
    const client = new FakeClient(call(TOOL_NAMES.status, {}), final1, say('Até mais!'));
    const agent = agentWith(client);
    await agent.handleTurn({ phone: carlos, messages: [inbound('Quem já respondeu?')] });
    await agent.handleTurn({ phone: carlos, messages: [inbound('Obrigado!')] });

    const turn1 = client.requests[1]!.messages; // user, system, assistant(tool_use), user(tool_result)
    const turn2 = client.requests[2]!.messages; // ...turn1, assistant(final), user, system
    expect(turn2.slice(0, turn1.length)).toEqual(turn1);
    expect(turn2[turn1.length]).toEqual({ role: 'assistant', content: final1.content });
    expect(turn2.slice(turn1.length + 1).map((m) => m.role)).toEqual(['user', 'system']);
    expect(contentText(turn2.at(-1)!)).toContain('Primeira conversa com esta pessoa: não');

    // O bloco thinking com a assinatura volta exatamente como veio.
    const firstAssistant = turn2[2]!.content as Anthropic.ContentBlockParam[];
    expect(firstAssistant[0]).toMatchObject({ type: 'thinking', signature: expect.stringMatching(/^sig_/) });

    expect(await storedRoles(carlos)).toEqual([
      'user', 'system', 'assistant', 'user', 'assistant',
      'user', 'system', 'assistant',
    ]);
  });
});

describe('registrar respostas', () => {
  it('confirma a família no banco, reage com ❤️ e devolve as mudanças', async () => {
    const pedro = await t.guestId('Pedro Souza');
    const carlosId = await t.guestId('Carlos Souza');
    const client = new FakeClient(
      call(TOOL_NAMES.register, {
        respostas: [
          { convidado_id: carlosId, presenca: 'sim' },
          { convidado_id: pedro, presenca: 'sim' },
        ],
      }),
      say('Prontinho! Presenças confirmadas.\n\nNos vemos na noite mais mágica do ano! ✨'),
    );
    const msg = inbound('Sim, confirma eu e o Pedro');
    const r = await agentWith(client).handleTurn({ phone: carlos, messages: [msg] });

    expect(await t.statusOf('Carlos Souza')).toBe('attending');
    expect(await t.statusOf('Pedro Souza')).toBe('attending');
    expect(await t.statusOf('Marta Souza')).toBe('pending');
    expect(r.reaction).toEqual({ emoji: '❤️', waMessageId: msg.waMessageId });
    expect(r.rsvpChanges.map((c) => c.full_name).sort()).toEqual(['Carlos Souza', 'Pedro Souza']);
    expect(r.replies).toEqual(['Prontinho! Presenças confirmadas.', 'Nos vemos na noite mais mágica do ano! ✨']);

    const audit = await t.db.query<{ wa_message_id: string; origin_phone: string }>(
      'select wa_message_id, origin_phone from public.rsvp_events',
    );
    expect(audit.rows).toHaveLength(2);
    expect(audit.rows.every((a) => a.wa_message_id === msg.waMessageId && a.origin_phone === carlos)).toBe(true);

    const toolResult = client.requests[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    expect(toolResult[0]!.is_error).toBeUndefined();
    expect(JSON.parse(toolResult[0]!.content as string)).toMatchObject({ ok: true });
  });

  it('recusa reage com 😢; repetir a mesma resposta não reage de novo', async () => {
    const id = await t.guestId('Carlos Souza');
    const decline = () => call(TOOL_NAMES.register, { respostas: [{ convidado_id: id, presenca: 'nao' }] });
    const client = new FakeClient(decline(), say('Que pena!'), decline(), say('Já estava assim.'));
    const agent = agentWith(client);

    const first = await agent.handleTurn({ phone: carlos, messages: [inbound('Não vou poder ir')] });
    expect(first.reaction?.emoji).toBe('😢');
    expect(await t.statusOf('Carlos Souza')).toBe('declined');

    const again = await agent.handleTurn({ phone: carlos, messages: [inbound('Não vou mesmo')] });
    expect(again.reaction).toBeNull();
    expect(again.rsvpChanges).toEqual([]);
  });

  it('não grava para outra família (nem revela que existe)', async () => {
    const joana = await t.guestId('Joana Barbosa');
    const client = new FakeClient(
      call(TOOL_NAMES.register, { respostas: [{ convidado_id: joana, presenca: 'sim' }] }),
      say('Não consigo.'),
    );
    const r = await agentWith(client).handleTurn({ phone: carlos, messages: [inbound('Confirma a Joana')] });

    expect(await t.statusOf('Joana Barbosa')).toBe('pending');
    expect(r.reaction).toBeNull();
    const result = (client.requests[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0]!;
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('não é da família');
    expect(result.content).not.toContain('Joana');
  });

  it('menor responde só por si', async () => {
    const pedro = await t.guestId('Pedro Souza');
    const client = new FakeClient(
      call(TOOL_NAMES.register, { respostas: [{ convidado_id: pedro, presenca: 'sim' }] }),
      say('Quem confirma o Pedro é um adulto da família.'),
    );
    await agentWith(client).handleTurn({ phone: bia, messages: [inbound('Confirma o Pedro')] });

    expect(await t.statusOf('Pedro Souza')).toBe('pending');
    const result = (client.requests[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0]!;
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('não pode responder por essa pessoa');
  });

  it('com as confirmações encerradas, nada é gravado e o contexto avisa', async () => {
    await t.db.exec('update public.rsvp_settings set accepting_responses = false where id = 1');
    const id = await t.guestId('Carlos Souza');
    const client = new FakeClient(
      call(TOOL_NAMES.register, { respostas: [{ convidado_id: id, presenca: 'sim' }] }),
      say('Encerradas.'),
    );
    await agentWith(client).handleTurn({ phone: carlos, messages: [inbound('Vou sim')] });

    expect(contentText(client.requests[0]!.messages[1]!)).toContain('Confirmações: ENCERRADAS');
    expect(await t.statusOf('Carlos Souza')).toBe('pending');
  });
});

describe('controle do loop', () => {
  it('na última iteração proíbe ferramentas, e a pessoa sempre recebe resposta', async () => {
    const client = new FakeClient(
      ...Array.from({ length: 5 }, () => call(TOOL_NAMES.status, {})),
      say('Aqui está a situação.'),
    );
    const r = await agentWith(client).handleTurn({ phone: carlos, messages: [inbound('Situação?')] });

    expect(client.requests).toHaveLength(6);
    expect(client.requests.slice(0, 5).every((q) => q.tool_choice === undefined)).toBe(true);
    expect(client.requests[5]!.tool_choice).toEqual({ type: 'none' });
    expect(r.stop).toBe('end_turn');
    expect(r.replies).toEqual(['Aqui está a situação.']);
  });

  it('se ainda assim pedir ferramenta, responde com a mensagem fixa e o histórico fica válido', async () => {
    const client = new FakeClient(...Array.from({ length: 6 }, () => call(TOOL_NAMES.status, {})));
    const r = await agentWith(client).handleTurn({ phone: carlos, messages: [inbound('Situação?')] });

    expect(r.stop).toBe('max_iterations');
    expect(r.replies).toEqual([FIXED_REPLIES.error]);
    expect((await storedRoles(carlos)).slice(-2)).toEqual(['user', 'assistant']);
  });

  it('resposta cortada por max_tokens no meio de uma ferramenta: não executa e fecha o par tool_use/tool_result', async () => {
    const id = await t.guestId('Carlos Souza');
    const client = new FakeClient(
      reply([thinking(), toolUse(TOOL_NAMES.register, { respostas: [{ convidado_id: id, presenca: 'sim' }] })], 'max_tokens'),
    );
    const r = await agentWith(client).handleTurn({ phone: carlos, messages: [inbound('Vou!')] });

    expect(await t.statusOf('Carlos Souza')).toBe('pending');
    expect(r.stop).toBe('max_tokens');
    expect(r.replies).toEqual([FIXED_REPLIES.error]);
    expect(await storedRoles(carlos)).toEqual(['user', 'system', 'assistant', 'user', 'assistant']);
  });

  it('recusa de segurança: mensagem fixa, aviso à família e sessão encerrada', async () => {
    const client = new FakeClient(
      reply([], 'refusal', { stop_details: { type: 'refusal', category: null, explanation: null } } as Partial<Anthropic.Message>),
      say('Olá de novo!'),
    );
    const agent = agentWith(client);
    const r = await agent.handleTurn({ phone: carlos, messages: [inbound('...')] });

    expect(r.outcome).toBe('refusal');
    expect(r.replies).toEqual([FIXED_REPLIES.refusal]);
    expect(r.forwards).toHaveLength(1);
    const sessions = await t.db.query<{ closed_at: string | null; summary: string | null }>(
      'select closed_at, summary from public.wa_sessions where phone = $1',
      [carlos],
    );
    expect(sessions.rows).toHaveLength(1);
    expect(sessions.rows[0]!.closed_at).not.toBeNull();

    // A próxima mensagem começa do zero (sem reenviar o que causou a recusa).
    await agent.handleTurn({ phone: carlos, messages: [inbound('Oi')] });
    expect(client.requests[1]!.messages.map((m) => m.role)).toEqual(['user', 'system']);
  });

  it('erro da API: mensagem fixa, histórico válido e o turno seguinte funciona', async () => {
    const client = new FakeClient(() => new Error('overloaded'), say('Voltei!'));
    const agent = agentWith(client);
    const r = await agent.handleTurn({ phone: carlos, messages: [inbound('Oi')] });

    expect(r.outcome).toBe('error');
    expect(r.replies).toEqual([FIXED_REPLIES.error]);
    await agent.handleTurn({ phone: carlos, messages: [inbound('Oi de novo')] });
    expect(client.requests[1]!.messages.map((m) => m.role)).toEqual(['user', 'system', 'assistant', 'user', 'system']);
  });

  it('ferramenta que lança exceção vira erro para o modelo, sem derrubar o turno', async () => {
    const client = new FakeClient(call(TOOL_NAMES.status, {}), say('Tive um problema.'));
    const repo = { ...t.repo, householdStatus: t.repo.householdStatus };
    let calls = 0;
    repo.householdStatus = async (phone) => {
      calls += 1;
      if (calls > 1) throw new Error('banco fora do ar');
      return t.repo.householdStatus(phone);
    };
    const r = await createAgent({ repo, client }).handleTurn({ phone: carlos, messages: [inbound('Situação?')] });

    const result = (client.requests[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0]!;
    expect(result.is_error).toBe(true);
    expect(r.replies).toEqual(['Tive um problema.']);
  });
});

describe('entrada e saída', () => {
  it('mensagens que chegam juntas viram uma só, com áudio e imagem marcados', async () => {
    const client = new FakeClient(say('Entendi!'));
    const last = inbound('', 'image');
    await agentWith(client).handleTurn({
      phone: carlos,
      messages: [inbound('Oi'), inbound('a festa é que horas?', 'audio'), { ...last, text: null }],
    });
    expect(client.requests[0]!.messages[0]).toEqual({
      role: 'user',
      content: 'Oi\n[áudio transcrito] a festa é que horas?\n[enviou uma imagem]',
    });
  });

  it('teto diário por telefone: responde sem chamar o modelo', async () => {
    await t.db.exec('update public.rsvp_settings set turns_per_phone_per_day = 1 where id = 1');
    const client = new FakeClient(say('Oi!'));
    const agent = agentWith(client);
    await agent.handleTurn({ phone: carlos, messages: [inbound('Oi')] });
    const r = await agent.handleTurn({ phone: carlos, messages: [inbound('Oi de novo')] });

    expect(r.outcome).toBe('limited');
    expect(r.replies).toEqual([FIXED_REPLIES.phoneLimit]);
    expect(client.requests).toHaveLength(1);
  });

  it('a reação do código tem prioridade sobre a do agente', async () => {
    const id = await t.guestId('Carlos Souza');
    const client = new FakeClient(
      reply(
        [
          thinking(),
          toolUse(TOOL_NAMES.react, { emoji: '🎉' }),
          toolUse(TOOL_NAMES.register, { respostas: [{ convidado_id: id, presenca: 'sim' }] }),
        ],
        'tool_use',
      ),
      say('Confirmado!'),
    );
    const r = await agentWith(client).handleTurn({ phone: carlos, messages: [inbound('Vou!')] });
    expect(r.reaction?.emoji).toBe('❤️');
    // Os dois resultados voltam numa única mensagem.
    expect((client.requests[1]!.messages.at(-1)!.content as unknown[]).length).toBe(2);
  });

  it('formata para o WhatsApp e divide em mensagens curtas', () => {
    expect(toWhatsApp('## Título\n**Negrito** e __itálico__')).toBe('Título\n*Negrito* e _itálico_');
    const long = 'a'.repeat(200);
    expect(splitReply(`Oi, Carlos!\n\n${long}\n\n${long}\n\n${long}\n\n${long}\n\n${long}`)).toHaveLength(4);
    expect(splitReply('Oi!\n\nTudo certo por aqui.')).toEqual(['Oi!\n\nTudo certo por aqui.']);
    expect(splitReply(`${long}\n\n${long}`)).toEqual([long, long]);
    expect(splitReply('')).toEqual([]);
  });
});
