/**
 * Ferramentas da Aifos contra o banco real (PGlite): autorização no código,
 * identificação pelo nome em dois passos (buscar → confirmar), limites por turno,
 * validação de entrada e efeitos (reação, avisos, notas).
 */
import type Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAgent } from '../supabase/functions/_shared/agent/index.ts';
import {
  collectFoundGuestIds,
  emptyEffects,
  executeTool,
  TOOL_NAMES,
  type ToolContext,
} from '../supabase/functions/_shared/agent/tools.ts';
import { call, contentText, createTestDb, DEMO_PHONES, FakeClient, inbound, say, type TestDb } from './support/agent.ts';

const { carlos, desconhecido } = DEMO_PHONES;
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
  await t.touch(desconhecido, 'Jô');
});

function ctx(phone: string): ToolContext {
  return {
    repo: t.repo,
    phone,
    waMessageId: 'wamid_x',
    foundGuestIds: new Set(),
    effects: emptyEffects(),
    calls: new Map(),
  };
}

const run = async (c: ToolContext, name: string, input: unknown) => {
  const r = await executeTool(name, input, c);
  return { ...r, data: JSON.parse(r.content) as Record<string, unknown> };
};

describe('detalhes da festa só para quem está na lista', () => {
  it('recusa remetente fora da lista e libera para quem está', async () => {
    const outsider = await run(ctx(desconhecido), TOOL_NAMES.facts, {});
    expect(outsider.isError).toBe(true);
    expect(outsider.content).not.toMatch(/Amazonas|20h|fevereiro|Casa de Pedra/);

    const guest = await run(ctx(carlos), TOOL_NAMES.facts, {});
    expect(guest.isError).toBe(false);
    expect(guest.data.fatos).toContain('Av. Amazonas, 428');
  });

  it('libera depois que a pessoa se identifica pelo nome', async () => {
    const c = ctx(desconhecido);
    const found = await run(c, TOOL_NAMES.find, { nome_completo: 'Joana Barbosa' });
    await run(c, TOOL_NAMES.confirmIdentity, { convidado_id: found.data.convidado_id });
    expect((await run(c, TOOL_NAMES.facts, {})).data.fatos).toContain('Av. Amazonas, 428');
  });

  it('o contexto de quem está fora da lista não revela a data (contagem nem prazo)', async () => {
    const client = new FakeClient(say('Olá!'));
    await createAgent({ repo: t.repo, client }).handleTurn({ phone: desconhecido, messages: [inbound('Oi!')] });
    const context = contentText(client.requests[0]!.messages[1]!);
    expect(context).toContain('NÃO identificado');
    expect(context).toContain('NÃO passe nenhuma informação da festa');
    expect(context).not.toMatch(/Faltam|A festa é|Prazo|Confirmações/);
  });
});

describe('identificação pelo nome', () => {
  it('encontra convidado sem telefone, confirma e passa a responder só por si', async () => {
    const c = ctx(desconhecido);
    const found = await run(c, TOOL_NAMES.find, { nome_completo: 'joana barbosa' });
    expect(found.data).toMatchObject({ resultado: 'encontrado', nome: 'Joana Barbosa' });

    const linked = await run(c, TOOL_NAMES.confirmIdentity, { convidado_id: found.data.convidado_id });
    expect(linked.isError).toBe(false);
    expect(linked.data.situacao).toContain('identificado pelo nome completo');
    // Não vê o resto da família.
    expect(linked.data.situacao).not.toContain('João Carlos');

    const joana = await t.guestId('Joana Barbosa');
    const ok = await run(c, TOOL_NAMES.register, { respostas: [{ convidado_id: joana, presenca: 'sim' }] });
    expect(ok.isError).toBe(false);
    expect(await t.statusOf('Joana Barbosa')).toBe('attending');

    const joao = await t.guestId('João Carlos Barbosa');
    const denied = await run(c, TOOL_NAMES.register, { respostas: [{ convidado_id: joao, presenca: 'sim' }] });
    expect(denied.isError).toBe(true);
    expect(await t.statusOf('João Carlos Barbosa')).toBe('pending');
  });

  it('não aceita id que não veio de buscar_convidado (mesmo que seja um convidado real)', async () => {
    const c = ctx(desconhecido);
    const lucia = await t.guestId('Lúcia Helena Dias');
    const r = await run(c, TOOL_NAMES.confirmIdentity, { convidado_id: lucia });
    expect(r.isError).toBe(true);
    const contacts = await t.db.query('select 1 from public.wa_contacts where linked_guest_id is not null');
    expect(contacts.rows).toHaveLength(0);
  });

  it('convidado com outro telefone: não devolve id nem vincula', async () => {
    const c = ctx(desconhecido);
    const r = await run(c, TOOL_NAMES.find, { nome_completo: 'João Carlos Barbosa' });
    expect(r.data.resultado).toBe('tem_outro_telefone');
    expect(r.data).not.toHaveProperty('convidado_id');
    expect(c.foundGuestIds.size).toBe(0);
  });

  it('convidado com outro telefone: o código pede confirmação aos organizadores (uma vez só)', async () => {
    const c = ctx(desconhecido);
    const r = await run(c, TOOL_NAMES.find, { nome_completo: 'joão carlos barbosa' });
    expect(r.data).toMatchObject({ resultado: 'tem_outro_telefone', nome: 'João Carlos Barbosa', pedido_a_familia: 'enviado' });
    expect(r.data.orientacao).toMatch(/não passe nenhum detalhe da festa/i);
    expect(c.effects.identityRequests).toEqual([
      expect.objectContaining({
        phone: desconhecido, claimed_name: 'joão carlos barbosa', display_name: 'Jô',
        guest_name: 'João Carlos Barbosa', household: 'Família Barbosa', guest_phone: '+5521999990000',
      }),
    ]);

    // Insistir não gera outro aviso aos organizadores.
    const again = ctx(desconhecido);
    const r2 = await run(again, TOOL_NAMES.find, { nome_completo: 'João Carlos Barbosa' });
    expect(r2.data.pedido_a_familia).toBe('ja_estava_aguardando');
    expect(again.effects.identityRequests).toEqual([]);
  });

  it('pedir_confirmacao_da_familia: nome não encontrado vira pedido sem convidado sugerido', async () => {
    const c = ctx(desconhecido);
    const r = await run(c, TOOL_NAMES.askFamily, { nome_informado: 'Rafael Quintela' });
    expect(r.data).toMatchObject({ ok: true, pedido_a_familia: 'enviado' });
    expect(c.effects.identityRequests).toEqual([
      expect.objectContaining({ claimed_name: 'Rafael Quintela', guest_name: null, guest_phone: null }),
    ]);
    // Uma vez por turno.
    expect((await run(c, TOOL_NAMES.askFamily, { nome_informado: 'Rafael Quintela' })).data.erro).toContain('Limite');
    // Quem está na lista não precisa.
    expect((await run(ctx(carlos), TOOL_NAMES.askFamily, { nome_informado: 'Carlos Souza' })).isError).toBe(true);
    expect((await run(ctx(desconhecido), TOOL_NAMES.askFamily, { nome_informado: ' ' })).isError).toBe(true);
  });

  it('depois que a família recusa, a Aifos não pede de novo', async () => {
    const c = ctx(desconhecido);
    await run(c, TOOL_NAMES.askFamily, { nome_informado: 'Rafael Quintela' });
    const [request] = c.effects.identityRequests;
    await t.rpc('bot_resolve_identity_request', { p_id: request!.id, p_accept: false, p_admin_phone: carlos, p_guest_name: null });
    const r = await run(ctx(desconhecido), TOOL_NAMES.askFamily, { nome_informado: 'Rafael Quintela' });
    expect(r.isError).toBe(true);
    expect(r.data.erro).toMatch(/não reconhece este número/);
    const find = await run(ctx(desconhecido), TOOL_NAMES.find, { nome_completo: 'João Carlos Barbosa' });
    expect(find.data).toMatchObject({ resultado: 'tem_outro_telefone' });
    expect(find.data.orientacao).toMatch(/não reconhece este número/);
  });

  it('o contexto avisa o pedido pendente, a recusa e, depois de aceito, que a pessoa já foi avisada', async () => {
    const contextOf = async (phone: string) => {
      const client = new FakeClient(say('Olá!'));
      await createAgent({ repo: t.repo, client }).handleTurn({ phone, messages: [inbound('Oi!')] });
      return contentText(client.requests[0]!.messages.at(-1)!);
    };
    const c = ctx(desconhecido);
    await run(c, TOOL_NAMES.askFamily, { nome_informado: 'Jô Barbosa' });
    expect(await contextOf(desconhecido)).toContain('AGUARDANDO os organizadores');

    const id = c.effects.identityRequests[0]!.id;
    await t.rpc('bot_resolve_identity_request', { p_id: id, p_accept: true, p_admin_phone: carlos, p_guest_name: 'Joana Barbosa' });
    const accepted = await contextOf(desconhecido);
    expect(accepted).toContain('identificado pelo telefone cadastrado');
    expect(accepted).toContain('confirmado pelos organizadores');
    expect(accepted).not.toContain('AGUARDANDO');
  });

  it('nome incompleto, ambíguo ou ausente', async () => {
    const c = ctx(desconhecido);
    expect((await run(c, TOOL_NAMES.find, { nome_completo: 'Joana' })).data.resultado).toBe('nome_incompleto');
    expect((await run(c, TOOL_NAMES.find, { nome_completo: 'Harry Potter' })).data.resultado).toBe('nao_encontrado');
  });

  it('quem já é identificado pelo telefone não busca outras pessoas', async () => {
    const r = await run(ctx(carlos), TOOL_NAMES.find, { nome_completo: 'Joana Barbosa' });
    expect(r.isError).toBe(true);
  });

  it('limita buscas por turno (contra varredura da lista)', async () => {
    const c = ctx(desconhecido);
    for (let i = 0; i < 3; i++) await run(c, TOOL_NAMES.find, { nome_completo: `Fulano Silva ${i}` });
    const fourth = await run(c, TOOL_NAMES.find, { nome_completo: 'Joana Barbosa' });
    expect(fourth.isError).toBe(true);
    expect(fourth.data.erro).toContain('Limite');
  });

  it('buscar num turno e confirmar no seguinte (o id vem do histórico gravado)', async () => {
    const client = new FakeClient(
      call(TOOL_NAMES.find, { nome_completo: 'Joana Barbosa' }),
      say('Você é a Joana Barbosa?'),
    );
    const agent = createAgent({ repo: t.repo, client });
    await agent.handleTurn({ phone: desconhecido, messages: [inbound('Sou Joana Barbosa')] });
    const toolResult = client.requests[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    const id = JSON.parse(toolResult[0]!.content as string).convidado_id as string;

    client.then(call(TOOL_NAMES.confirmIdentity, { convidado_id: id }), say('Prontinho, Joana!'));
    await agent.handleTurn({ phone: desconhecido, messages: [inbound('Sim, sou eu')] });
    const linked = (client.requests[3]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0]!;
    expect(linked.is_error).toBeUndefined();

    // A partir daí, o contexto já mostra a identidade.
    client.then(say('Oi, Joana!'));
    await agent.handleTurn({ phone: desconhecido, messages: [inbound('Oi')] });
    expect(contentText(client.requests[4]!.messages.at(-1)!)).toContain('Joana Barbosa, identificado pelo nome completo');
  });

  it('collectFoundGuestIds só considera resultados de buscar_convidado', () => {
    const history = [
      { role: 'assistant' as const, content: [{ type: 'tool_use', id: 'a', name: TOOL_NAMES.find, input: {} }] },
      {
        role: 'user' as const,
        content: [{ type: 'tool_result', tool_use_id: 'a', content: '{"ok":true,"resultado":"encontrado","convidado_id":"x1"}' }],
      },
      { role: 'assistant' as const, content: [{ type: 'tool_use', id: 'b', name: TOOL_NAMES.status, input: {} }] },
      {
        role: 'user' as const,
        content: [{ type: 'tool_result', tool_use_id: 'b', content: '{"ok":true,"resultado":"encontrado","convidado_id":"x2"}' }],
      },
    ];
    expect([...collectFoundGuestIds(history)]).toEqual(['x1']);
  });
});

describe('validação e efeitos', () => {
  it('registrar_resposta rejeita entradas inválidas antes do banco', async () => {
    const c = ctx(carlos);
    const id = await t.guestId('Carlos Souza');
    expect((await run(c, TOOL_NAMES.register, { respostas: [] })).isError).toBe(true);
    expect((await run(c, TOOL_NAMES.register, { respostas: [{ convidado_id: 'Carlos', presenca: 'sim' }] })).isError).toBe(true);
    expect((await run(c, TOOL_NAMES.register, { respostas: [{ convidado_id: id, presenca: 'talvez' }] })).isError).toBe(true);
    const conflict = await run(c, TOOL_NAMES.register, {
      respostas: [
        { convidado_id: id, presenca: 'sim' },
        { convidado_id: id, presenca: 'nao' },
      ],
    });
    expect(conflict.isError).toBe(true);
    expect(await t.statusOf('Carlos Souza')).toBe('pending');
  });

  it('respostas mistas na família: grava as duas e reage com ❤️', async () => {
    const c = ctx(carlos);
    const r = await run(c, TOOL_NAMES.register, {
      respostas: [
        { convidado_id: await t.guestId('Carlos Souza'), presenca: 'sim' },
        { convidado_id: await t.guestId('Marta Souza'), presenca: 'nao' },
      ],
    });
    expect(r.isError).toBe(false);
    expect(await t.statusOf('Carlos Souza')).toBe('attending');
    expect(await t.statusOf('Marta Souza')).toBe('declined');
    expect(c.effects.systemReaction).toBe('❤️');
  });

  it('reagir aceita só os emojis permitidos', async () => {
    const c = ctx(carlos);
    expect((await run(c, TOOL_NAMES.react, { emoji: '💩' })).isError).toBe(true);
    expect(c.effects.agentReaction).toBeNull();
    expect((await run(c, TOOL_NAMES.react, { emoji: '🐸' })).isError).toBe(false);
    expect(c.effects.agentReaction).toBe('🐸');
  });

  it('lembrar e nome preferido aparecem no contexto do turno seguinte', async () => {
    const c = ctx(carlos);
    expect((await run(c, TOOL_NAMES.remember, { nota: 'A avó vai de cadeira de rodas' })).isError).toBe(false);
    expect((await run(c, TOOL_NAMES.preferredName, { nome: 'Carlão' })).isError).toBe(false);
    expect((await run(c, TOOL_NAMES.remember, { nota: 'x'.repeat(201) })).isError).toBe(true);

    const client = new FakeClient(say('Oi, Carlão!'));
    await createAgent({ repo: t.repo, client }).handleTurn({ phone: carlos, messages: [inbound('Oi')] });
    const context = contentText(client.requests[0]!.messages[1]!);
    expect(context).toContain('Prefere ser chamado(a) de: "Carlão"');
    expect(context).toContain('- "A avó vai de cadeira de rodas"');
  });

  it('encaminhar_para_familia acumula avisos, com limite por turno', async () => {
    const c = ctx(carlos);
    await run(c, TOOL_NAMES.forward, { motivo: 'Carlos pergunta se pode levar a sogra' });
    await run(c, TOOL_NAMES.forward, { motivo: 'Segundo aviso' });
    expect((await run(c, TOOL_NAMES.forward, { motivo: 'Terceiro' })).isError).toBe(true);
    expect(c.effects.forwards).toEqual(['Carlos pergunta se pode levar a sogra', 'Segundo aviso']);
  });

  it('guardar_recado grava em nome do remetente, mantém parágrafos e aparece no contexto', async () => {
    const c = ctx(carlos);
    const r = await run(c, TOOL_NAMES.message, {
      texto: 'Sofia,   que noite linda!\n\n  Com amor.',
      assinatura: '',
      veio_de_audio: true,
    });
    expect(r.data).toEqual({ ok: true, guardado: true, na_vaga_de: 'Carlos Souza', substituiu_o_anterior: false });
    const saved = await t.rpc('bot_guest_messages', {});
    expect(saved).toEqual([
      expect.objectContaining({ full_name: 'Carlos Souza', body: 'Sofia, que noite linda!\n\nCom amor.', signature: null, source: 'audio' }),
    ]);

    const again = await run(ctx(carlos), TOOL_NAMES.message, { texto: 'Novo', assinatura: 'Tio Carlos', veio_de_audio: false });
    expect(again.data.substituiu_o_anterior).toBe(true);

    const client = new FakeClient(say('Oi!'));
    await createAgent({ repo: t.repo, client }).handleTurn({ phone: carlos, messages: [inbound('Oi')] });
    const context = contentText(client.requests[0]!.messages[1]!);
    expect(context).toMatch(/- Carlos Souza \(o remetente\): já tem recado, escrito pelo remetente em .*"Tio Carlos": "Novo" \(o remetente pode trocar\)/);
    expect(context).toMatch(/- Pedro Souza: ainda não tem recado; o remetente pode deixar\./);
  });

  it('guardar_recado: o responsável deixa recado por outro membro; só o dono ou quem escreveu troca', async () => {
    const { marta, bia } = DEMO_PHONES;
    await t.touch(marta);
    await t.touch(bia);
    const status = (await t.rpc('bot_household_status', { p_phone: carlos })) as { members: { id: string; full_name: string }[] };
    const id = (name: string) => status.members.find((m) => m.full_name === name)!.id;
    const save = (phone: string, texto: string, para = '', assinatura = '') =>
      run(ctx(phone), TOOL_NAMES.message, { texto, assinatura, veio_de_audio: false, para_convidado_id: para });

    // O pai deixa o recado da família na vaga do filho pequeno e o da filha.
    expect((await save(carlos, 'Da família toda', id('Pedro Souza'), 'Família Souza')).data).toMatchObject({
      ok: true,
      na_vaga_de: 'Pedro Souza',
    });
    expect((await save(carlos, 'Da Bia', id('Bia Souza'))).data).toMatchObject({ ok: true, na_vaga_de: 'Bia Souza' });
    // ...e troca o que ele mesmo escreveu.
    expect((await save(carlos, 'Da família, versão 2', id('Pedro Souza'), 'Família Souza')).data).toMatchObject({
      substituiu_o_anterior: true,
    });

    // A mãe também responde pela família, mas não troca o que o pai escreveu.
    const byMarta = await save(marta, 'Troca', id('Pedro Souza'));
    expect(byMarta.isError).toBe(true);
    expect(byMarta.content).toMatch(/já tem um recado .*\(Pedro Souza\)/);

    // A filha menor não deixa recado pelos outros, mas pode reescrever o dela.
    expect((await save(bia, 'Pelo Pedro', id('Pedro Souza'))).isError).toBe(true);
    expect((await save(bia, 'Escrito por mim')).data).toMatchObject({ ok: true, na_vaga_de: 'Bia Souza', substituiu_o_anterior: true });
    // Depois disso, nem o pai troca o recado dela.
    expect((await save(carlos, 'De novo', id('Bia Souza'))).isError).toBe(true);

    const saved = (await t.rpc('bot_guest_messages', {})) as { full_name: string; body: string; sent_by: string | null }[];
    expect(saved.map((m) => [m.full_name, m.body, m.sent_by])).toEqual([
      ['Pedro Souza', 'Da família, versão 2', 'Carlos Souza'],
      ['Bia Souza', 'Escrito por mim', null],
    ]);

    // Fora da família: recusado.
    const joana = (await t.rpc('bot_household_status', { p_phone: DEMO_PHONES.joao })) as { members: { id: string }[] };
    expect((await save(carlos, 'Oi', joana.members[0]!.id)).isError).toBe(true);
  });

  it('o contexto só mostra o texto do recado a quem pode trocá-lo', async () => {
    const { marta } = DEMO_PHONES;
    await t.touch(marta);
    const status = (await t.rpc('bot_household_status', { p_phone: carlos })) as { members: { id: string; full_name: string }[] };
    const pedro = status.members.find((m) => m.full_name === 'Pedro Souza')!.id;
    await run(ctx(carlos), TOOL_NAMES.message, { texto: 'Segredo do Pedro', assinatura: '', veio_de_audio: false, para_convidado_id: pedro });

    const client = new FakeClient(say('Oi!'));
    await createAgent({ repo: t.repo, client }).handleTurn({ phone: marta, messages: [inbound('Oi')] });
    const context = contentText(client.requests[0]!.messages[1]!);
    expect(context).toMatch(/- Pedro Souza: já tem recado, escrito por outra pessoa da família; o remetente não pode ver nem trocar\./);
    expect(context).not.toMatch(/Segredo do Pedro/);
  });

  it('guardar_recado recusa quem não está na lista, texto inválido e uso repetido', async () => {
    const outsider = await run(ctx(desconhecido), TOOL_NAMES.message, { texto: 'Oi', assinatura: '', veio_de_audio: false });
    expect(outsider.isError).toBe(true);
    expect(outsider.content).toMatch(/Só convidados da lista/);

    const c = ctx(carlos);
    expect((await run(c, TOOL_NAMES.message, { texto: '  ', assinatura: '', veio_de_audio: false })).isError).toBe(true);
    expect((await run(c, TOOL_NAMES.message, { texto: 'Oi', assinatura: 'x'.repeat(81), veio_de_audio: false })).isError).toBe(true);
    expect((await run(c, TOOL_NAMES.message, { texto: 'Oi', assinatura: '', veio_de_audio: false })).isError).toBe(true);
    expect(await t.rpc('bot_guest_messages', {})).toEqual([]);

    const fresh = ctx(carlos);
    expect((await run(fresh, TOOL_NAMES.message, { texto: 'x'.repeat(1001), assinatura: '', veio_de_audio: false })).isError).toBe(true);
  });

  it('ferramenta desconhecida vira erro', async () => {
    expect((await run(ctx(carlos), 'apagar_lista', {})).isError).toBe(true);
  });
});

describe('pais da Sofia e equipe da festa', () => {
  const contextOf = async (phone: string) => {
    const client = new FakeClient(say('Olá!'));
    await createAgent({ repo: t.repo, client }).handleTurn({ phone, messages: [inbound('Oi!')] });
    return contentText(client.requests[0]!.messages.at(-1)!);
  };

  it('o contexto diz quem é, sem família, prazo nem presença; pede o nome quando não sabe', async () => {
    await t.rpc('bot_ensure_special_contact', { p_phone: desconhecido, p_role: 'staff' });
    const staff = await contextOf(desconhecido);
    expect(staff).toContain('Remetente: da equipe da festa (cerimonial), identificado pelo telefone. NÃO é convidado');
    expect(staff).toContain('pergunte como a pessoa se chama');
    expect(staff).not.toContain('Confirmações:');
    expect(staff).not.toContain('[id ');

    await t.rpc('bot_ensure_special_contact', { p_phone: carlos, p_role: 'host' });
    const host = await contextOf(carlos);
    expect(host).toContain('Remetente: pai da Sofia (organizador da festa)');
    expect(host).toContain('Nome na lista: "Carlos Souza".');
    expect(host).not.toContain('Pedro Souza');
  });

  it('com nome e parentesco gravados pelos organizadores, a Aifos já sabe quem é', async () => {
    await t.rpc('bot_ensure_special_contact', { p_phone: desconhecido, p_role: 'host' });
    await t.db.query(`update public.guests set full_name = 'Helena', relationship = 'mãe' where role = 'host'`);
    const host = await contextOf(desconhecido);
    expect(host).toContain('Remetente: mãe da Sofia (organizador da festa)');
    expect(host).toContain('Nome na lista: "Helena".');
    expect(host).not.toContain('pergunte como a pessoa se chama');
  });

  it('libera os detalhes da festa, recusa presença e exige recado assinado', async () => {
    await t.rpc('bot_ensure_special_contact', { p_phone: desconhecido, p_role: 'staff' });
    const c = ctx(desconhecido);
    expect((await run(c, TOOL_NAMES.facts, {})).data.fatos).toContain('Av. Amazonas, 428');

    const status = await t.repo.householdStatus(desconhecido);
    const id = status.identified ? status.actor_id : '';
    const rsvp = await run(c, TOOL_NAMES.register, { respostas: [{ convidado_id: id, presenca: 'sim' }] });
    expect(rsvp.data.erro).toMatch(/não são convidados/);

    const message = { texto: 'Parabéns, Sofia!', veio_de_audio: false, para_convidado_id: '' };
    expect((await run(c, TOOL_NAMES.message, { ...message, assinatura: '' })).data.erro).toMatch(/vai assinado/);
    expect((await run(c, TOOL_NAMES.message, { ...message, assinatura: 'Rita' })).data).toMatchObject({ ok: true, guardado: true });
  });
});

describe('O Profeta Diário: endereço e palavra mágica só para quem está na lista', () => {
  const access = { url: 'https://convite.example/profeta/', password: 'Lúmos Máxima' };

  it('recusa fora da lista; libera para convidado; sem os secrets, diz que ainda não está no ar', async () => {
    const outsider = await run({ ...ctx(desconhecido), profeta: access }, TOOL_NAMES.profeta, {});
    expect(outsider.isError).toBe(true);
    expect(outsider.content).not.toMatch(/convite\.example|Lúmos/);

    const guest = await run({ ...ctx(carlos), profeta: access }, TOOL_NAMES.profeta, {});
    expect(guest.isError).toBe(false);
    expect(guest.data).toMatchObject({ endereco: access.url, palavra_magica: 'Lúmos Máxima' });

    const off = await run(ctx(carlos), TOOL_NAMES.profeta, {});
    expect(off.isError).toBe(true);
    expect(off.content).toMatch(/ainda não está no ar/);
  });

  it('a palavra mágica nunca está no prompt', async () => {
    const { SYSTEM_PROMPT } = await import('../supabase/functions/_shared/agent/prompt.ts');
    expect(SYSTEM_PROMPT).not.toMatch(/convite\.example\.com\/profeta|palavra mágica é/i);
  });
});

