/**
 * Peças puras do canal do WhatsApp: leitura do evento da Evolution (inclusive
 * remetentes "@lid"), telefones, relatório determinístico, chamadas HTTP à
 * Evolution e à OpenAI, comparação do segredo e versões fixadas no deno.json.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createEvolutionClient,
  EvolutionError,
  isTransientSendError,
  typingDelayMs,
} from '../supabase/functions/_shared/whatsapp/evolution.ts';
import { safeEqual } from '../supabase/functions/_shared/whatsapp/http.ts';
import { parseUpsert } from '../supabase/functions/_shared/whatsapp/inbound.ts';
import { formatPhone, parsePhoneList, phoneFromJid, samePhone } from '../supabase/functions/_shared/whatsapp/phone.ts';
import {
  formatApproval,
  formatForward,
  formatGiftReport,
  formatGuestMessages,
  formatReport,
  type GiftReportEntry,
  type GuestMessageEntry,
  type ReportData,
} from '../supabase/functions/_shared/whatsapp/report.ts';
import { base64ToBytes, createOpenAiTranscriber } from '../supabase/functions/_shared/whatsapp/transcriber.ts';
import {
  isGiftsCommand,
  isMessagesCommand,
  isReportCommand,
  parseIdentityCommand,
  parseWallCommand,
} from '../supabase/functions/_shared/whatsapp/bot.ts';

const NOW = new Date('2026-11-10T15:00:00Z');
const nowSec = Math.floor(NOW.getTime() / 1000);

function upsert(over: { key?: Record<string, unknown>; message?: Record<string, unknown>; data?: Record<string, unknown>; root?: Record<string, unknown> } = {}) {
  return {
    event: 'messages.upsert',
    instance: 'convite',
    ...over.root,
    data: {
      key: { id: 'ABC123', fromMe: false, remoteJid: '5531988887777@s.whatsapp.net', ...over.key },
      pushName: 'Carlos',
      message: over.message ?? { conversation: 'Oi, Aifos!' },
      messageTimestamp: nowSec - 5,
      ...over.data,
    },
  };
}

const parse = (payload: unknown) => parseUpsert(payload, { instance: 'convite', now: NOW });

describe('parseUpsert', () => {
  it('lê texto simples e texto estendido', () => {
    expect(parse(upsert())).toEqual({
      ok: true,
      message: {
        waMessageId: 'ABC123',
        phone: '5531988887777',
        remoteJid: '5531988887777@s.whatsapp.net',
        pushName: 'Carlos',
        kind: 'text',
        body: 'Oi, Aifos!',
        audioSeconds: null,
      },
    });
    const extended = parse(upsert({ message: { extendedTextMessage: { text: 'Respondendo' } } }));
    expect(extended.ok && extended.message.body).toBe('Respondendo');
  });

  it('remetente @lid: usa o telefone de remoteJidAlt (ou senderPn); sem telefone, ignora', () => {
    const lid = parse(upsert({ key: { remoteJid: '138012345678915@lid', remoteJidAlt: '5527999990000@s.whatsapp.net' } }));
    expect(lid.ok && [lid.message.phone, lid.message.remoteJid]).toEqual(['5527999990000', '138012345678915@lid']);
    const old = parse(upsert({ key: { remoteJid: '138012345678915@lid', senderPn: '5527999990000@s.whatsapp.net' } }));
    expect(old.ok && old.message.phone).toBe('5527999990000');
    expect(parse(upsert({ key: { remoteJid: '138012345678915@lid' } }))).toEqual({ ok: false, reason: 'no_phone' });
  });

  it('ignora o que não é conversa de um convidado', () => {
    expect(parse(upsert({ key: { fromMe: true } }))).toEqual({ ok: false, reason: 'from_me' });
    expect(parse(upsert({ key: { remoteJid: '120363000000000000@g.us' } }))).toEqual({ ok: false, reason: 'group_or_broadcast' });
    expect(parse(upsert({ key: { remoteJid: 'status@broadcast' } }))).toEqual({ ok: false, reason: 'group_or_broadcast' });
    expect(parse(upsert({ key: { remoteJid: '1203630000@newsletter' } }))).toEqual({ ok: false, reason: 'group_or_broadcast' });
    expect(parse(upsert({ root: { instance: 'Outra' } }))).toEqual({ ok: false, reason: 'other_instance' });
    expect(parse(upsert({ root: { event: 'connection.update' } }))).toEqual({ ok: false, reason: 'not_message_event' });
    expect(parse({ event: 'messages.upsert', instance: 'convite', data: {} })).toEqual({ ok: false, reason: 'malformed' });
    expect(parse(upsert({ message: { reactionMessage: { text: '❤️' } } }))).toEqual({ ok: false, reason: 'not_content' });
    expect(parse(upsert({ message: { protocolMessage: { type: 0 } } }))).toEqual({ ok: false, reason: 'not_content' });
    expect(parse(upsert({ message: { messageContextInfo: {} } }))).toEqual({ ok: false, reason: 'not_content' });
  });

  it('ignora mensagens antigas (ressincronização do histórico)', () => {
    expect(parse(upsert({ data: { messageTimestamp: nowSec - 3600 } }))).toEqual({ ok: false, reason: 'too_old' });
  });

  it('aceita o nome do evento no formato MESSAGES_UPSERT', () => {
    expect(parse(upsert({ root: { event: 'MESSAGES_UPSERT' } })).ok).toBe(true);
  });

  it('classifica áudio, imagem, figurinha e outros; desembrulha mensagens temporárias', () => {
    const audio = parse(upsert({ message: { audioMessage: { seconds: 14.6, ptt: true, mimetype: 'audio/ogg; codecs=opus' } } }));
    expect(audio.ok && [audio.message.kind, audio.message.audioSeconds, audio.message.body]).toEqual(['audio', 15, null]);
    const image = parse(upsert({ message: { imageMessage: { caption: 'Olha o vestido' } } }));
    expect(image.ok && [image.message.kind, image.message.body]).toEqual(['image', 'Olha o vestido']);
    const sticker = parse(upsert({ message: { stickerMessage: {} } }));
    expect(sticker.ok && sticker.message.kind).toBe('sticker');
    const location = parse(upsert({ message: { locationMessage: { degreesLatitude: 1 } } }));
    expect(location.ok && location.message.kind).toBe('other');
    const ephemeral = parse(upsert({ message: { ephemeralMessage: { message: { conversation: 'Sumiu!' } } } }));
    expect(ephemeral.ok && ephemeral.message.body).toBe('Sumiu!');
  });

  it('limita o tamanho do texto e do nome', () => {
    const long = parse(upsert({ message: { conversation: 'a'.repeat(5000) }, data: { pushName: 'n'.repeat(200) } }));
    expect(long.ok && [long.message.body?.length, long.message.pushName?.length]).toEqual([4000, 80]);
  });
});

describe('telefones', () => {
  it('extrai o número do JID (inclusive com dispositivo) e rejeita o resto', () => {
    expect(phoneFromJid('5531988887777:12@s.whatsapp.net')).toBe('5531988887777');
    expect(phoneFromJid('138012345678915@lid')).toBeNull();
    expect(phoneFromJid('123@s.whatsapp.net')).toBeNull();
  });

  it('reconhece o mesmo celular com e sem o 9º dígito', () => {
    expect(samePhone('5531988887777', '553188887777')).toBe(true);
    expect(samePhone('553188887777', '5531988887777')).toBe(true);
    expect(samePhone('5531988887777', '5531988887770')).toBe(false);
    expect(samePhone('14155550100', '14155550100')).toBe(true);
  });

  it('lê ADMIN_PHONES e formata para leitura', () => {
    expect(parsePhoneList('5527999990000, +55 (27) 98888-7777;;abc')).toEqual(['5527999990000', '5527988887777']);
    expect(parsePhoneList(undefined)).toEqual([]);
    expect(formatPhone('5511999999999')).toBe('+55 11 99999-9999');
    expect(formatPhone('14155550100')).toBe('+14155550100');
  });
});

describe('comando do organizador', () => {
  it('aceita "relatório" com variações, e só isso', () => {
    for (const t of ['relatório', 'Relatorio', '/relatório', 'RELATÓRIO!', ' relatório completo ']) expect(isReportCommand(t)).toBe(true);
    for (const t of ['me manda o relatório', 'relatórios', '', null]) expect(isReportCommand(t)).toBe(false);
  });

  it('aceita "recados" com variações, e só isso', () => {
    for (const t of ['recados', 'Recado', '/recados', 'RECADOS!']) expect(isMessagesCommand(t)).toBe(true);
    for (const t of ['quero deixar um recado', 'relatório', '', null]) expect(isMessagesCommand(t)).toBe(false);
  });

  it('aceita "presentes" com variações, e só isso', () => {
    for (const t of ['presentes', 'Presente', '/presentes', 'PRESENTES!']) expect(isGiftsCommand(t)).toBe(true);
    for (const t of ['quero dar um presente', 'lista de presentes', 'recados', '', null]) expect(isGiftsCommand(t)).toBe(false);
  });

  it('"publicar N" / "retirar N" com variações, e só isso', () => {
    expect(parseWallCommand('publicar 7')).toEqual({ approve: true, id: 7 });
    expect(parseWallCommand('  /Publicar #12. ')).toEqual({ approve: true, id: 12 });
    expect(parseWallCommand('publicar o recado 3')).toEqual({ approve: true, id: 3 });
    expect(parseWallCommand('Retirar nº 5!')).toEqual({ approve: false, id: 5 });
    for (const t of ['publicar', 'publicar tudo', 'retirar 7 e 8', 'quero publicar 7', 'publicar -1', '', null]) {
      expect(parseWallCommand(t), String(t)).toBeNull();
    }
  });

  it('"aceitar N [nome]" / "recusar N": pedido de identidade', () => {
    expect(parseIdentityCommand('aceitar 12')).toEqual({ accept: true, id: 12, name: null });
    expect(parseIdentityCommand(' /Aceito o pedido #12. ')).toEqual({ accept: true, id: 12, name: null });
    expect(parseIdentityCommand('aceitar nº 3 Jefferson Rocha')).toEqual({ accept: true, id: 3, name: 'Jefferson Rocha' });
    expect(parseIdentityCommand('aceitar 3: como "Rafael  Quintela".')).toEqual({ accept: true, id: 3, name: 'Rafael Quintela' });
    expect(parseIdentityCommand('ACEITA 3 é a Lúcia Helena Dias')).toEqual({ accept: true, id: 3, name: 'Lúcia Helena Dias' });
    expect(parseIdentityCommand('Recusar 7')).toEqual({ accept: false, id: 7, name: null });
    expect(parseIdentityCommand('recuso 7, não conheço')).toEqual({ accept: false, id: 7, name: null });
    for (const t of ['aceitar', 'aceitar tudo', 'pode aceitar 12', 'aceitar12x', 'aceitar 1234567890', 'confirmar 12', '', null]) {
      expect(parseIdentityCommand(t), String(t)).toBeNull();
    }
  });
});

describe('relatório', () => {
  const report: ReportData = {
    generated_at: '2026-11-10T12:00:00Z',
    rsvp_open: true,
    deadline: '2027-01-31T23:59:00-03:00',
    totals: { guests: 6, attending: 3, declined: 1, pending: 2, attending_minors: 1 },
    households: [
      {
        label: 'Família Souza',
        members: [
          { full_name: 'Carlos Souza', is_minor: false, rsvp_status: 'attending', rsvp_updated_at: '2026-11-10T10:00:00Z' },
          { full_name: 'Marta Souza', is_minor: false, rsvp_status: 'attending', rsvp_updated_at: '2026-11-01T10:00:00Z' },
          { full_name: 'Pedro Souza', is_minor: true, rsvp_status: 'attending', rsvp_updated_at: '2026-11-10T10:00:00Z' },
        ],
      },
      {
        label: 'Família Barbosa',
        members: [
          { full_name: 'João Carlos Barbosa', is_minor: false, rsvp_status: 'declined', rsvp_updated_at: '2026-11-09T20:00:00Z' },
          { full_name: 'Joana Barbosa', is_minor: false, rsvp_status: 'pending', rsvp_updated_at: null },
        ],
      },
      { label: 'Vovó Lúcia', members: [{ full_name: 'Lúcia Helena Dias', is_minor: false, rsvp_status: 'pending', rsvp_updated_at: null }] },
    ],
  };

  it('resumo, novidades das últimas 24 h e listas por família', () => {
    const [header, attending, declined, pending, ...rest] = formatReport(report);
    expect(rest).toEqual([]);
    expect(header).toContain('📜 *Relatório da Professora Aifos*');
    expect(header).toContain('10/11/2026, 09:00');
    expect(header).toContain('✅ Confirmados: *3* (1 menor)');
    expect(header).toContain('Confirmações abertas até 31/01/2027, 23:59.');
    expect(header).toContain('• Carlos Souza (Família Souza): confirmou presença');
    expect(header).toContain('• João Carlos Barbosa (Família Barbosa): não vai');
    expect(header).not.toContain('Marta'); // mudou há mais de 24 h
    expect(attending).toBe('✅ *Confirmados* (3)\n• *Família Souza*: Carlos Souza, Marta Souza, Pedro Souza (menor)');
    expect(declined).toBe('❌ *Não vão* (1)\n• *Família Barbosa*: João Carlos Barbosa');
    expect(pending).toBe('⏳ *Sem resposta* (2)\n• *Família Barbosa*: Joana Barbosa\n• *Vovó Lúcia*: Lúcia Helena Dias');
  });

  it('diário: avisa quando não houve novidade; seções vazias somem', () => {
    const quiet: ReportData = {
      ...report,
      rsvp_open: false,
      totals: { guests: 1, attending: 0, declined: 0, pending: 1, attending_minors: 0 },
      households: [{ label: 'Vovó Lúcia', members: [{ full_name: 'Lúcia Helena Dias', is_minor: false, rsvp_status: 'pending', rsvp_updated_at: null }] }],
    };
    const messages = formatReport(quiet, 'daily');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('🦉 *Relatório diário da Professora Aifos*');
    expect(messages[0]).toContain('Nenhuma resposta nova nas últimas 24 horas.');
    expect(messages[0]).toContain('Confirmações *encerradas*.');
    expect(messages[0]).toContain('👥 Na lista: 1 convidado');
  });

  it('mostra os recados para a Sofia no resumo', () => {
    expect(formatReport({ ...report, messages: { total: 3, last_24h: 1 } })[0]).toContain('💌 Recados para a Sofia: *3* (1 nas últimas 24 h)');
    expect(formatReport({ ...report, messages: { total: 0, last_24h: 0 } })[0]).toContain('💌 Recados para a Sofia: *0*');
    expect(formatReport(report)[0]).not.toContain('💌');
    expect(formatReport({ ...report, messages: { total: 3, last_24h: 0, awaiting_approval: 2 } })[0]).toContain(
      '🕯️ Aguardando aprovação para o Salão do site: *2* (mande *recados*)',
    );
    expect(formatReport({ ...report, messages: { total: 3, last_24h: 0, awaiting_approval: 0 } })[0]).not.toContain('🕯️');
  });

  it('"recados" mostra número e estado no Salão, e como publicar ou retirar', () => {
    const entry = (id: number, approved: boolean): GuestMessageEntry => ({
      id,
      full_name: `Convidado ${id}`,
      household: 'Família Souza',
      signature: null,
      body: 'Parabéns!',
      source: 'text',
      approved,
      created_at: '2026-11-10T12:00:00Z',
      updated_at: '2026-11-10T12:00:00Z',
    });
    expect(formatGuestMessages([entry(4, true), entry(9, false)])).toEqual([
      '💌 *Recados para a Sofia* (2)\n\n' +
        '*#4 · Convidado 4* (Família Souza · 10/11) ✅ no Salão\nParabéns!\n\n' +
        '*#9 · Convidado 9* (Família Souza · 10/11) ⏳ aguardando\nParabéns!\n\n' +
        '🕯️ *Salão do site*: 1 pendurado(s), 1 aguardando.\nPara pendurar: *publicar 9*. Para tirar: *retirar 9*.',
    ]);
  });

  it('"recados" diz quem enviou o recado deixado por um responsável da família', () => {
    const [text] = formatGuestMessages([
      {
        full_name: 'Pedro Souza',
        household: 'Família Souza',
        signature: 'Família Souza',
        body: 'Da família toda!',
        source: 'text',
        sent_by: 'Carlos Souza',
        created_at: '2026-11-10T12:00:00Z',
        updated_at: '2026-11-10T12:00:00Z',
      },
    ]);
    expect(text).toContain('*Pedro Souza* (Família Souza · assinado "Família Souza" · enviado por Carlos Souza · 10/11)');
  });

  it('resposta de "publicar/retirar" só confirma o que o banco aceitou', () => {
    expect(formatApproval(4, true, { ok: true, approved: true, from: 'Tio Carlos' })).toBe(
      '🕯️ Carta #4 (de Tio Carlos) pendurada no Salão do site. Ela aparece em até 1 minuto.',
    );
    expect(formatApproval(4, false, { ok: true, approved: false, from: 'Tio Carlos' })).toBe('Carta #4 (de Tio Carlos) retirada do Salão do site.');
    expect(formatApproval(4, true, { ok: false, error: 'hidden' })).toBe('O recado #4 está oculto e não pode ir para o Salão do site.');
    expect(formatApproval(4, true, { ok: false, error: 'not_found' })).toContain('Não encontrei o recado #4');
  });

  it('"recados": um bloco por recado, dividido em várias mensagens quando passa do tamanho', () => {
    const entry = (n: number, body: string): GuestMessageEntry => ({
      full_name: `Convidado ${n}`,
      household: 'Família Souza',
      signature: n === 1 ? `Convidado ${n}` : null,
      body,
      source: 'text',
      created_at: '2026-11-10T12:00:00Z',
      updated_at: '2026-11-10T12:00:00Z',
    });
    expect(formatGuestMessages([entry(1, 'Parabéns!')])).toEqual([
      '💌 *Recados para a Sofia* (1)\n\n*Convidado 1* (Família Souza · 10/11)\nParabéns!',
    ]);
    const long = formatGuestMessages([1, 2, 3].map((n) => entry(n, 'x'.repeat(900))), 2000);
    expect(long).toHaveLength(2);
    expect(long[0]).toMatch(/^💌 \*Recados para a Sofia\* \(3\)/);
    expect(long[1]).toMatch(/^\*Convidado 3\*/);
    expect(long.every((m) => m.length <= 2000)).toBe(true);
  });

  it('aviso aos organizadores identifica o contato', () => {
    const known = formatForward(
      { phone: '5531988887777', display_name: 'Carlão', guest_name: 'Carlos Souza', household: 'Família Souza', verified_by: 'phone' },
      'Carlos pergunta se pode levar a cadeira de rodas da avó.',
      '+55 31 98888-7777',
    );
    expect(known).toBe(
      '🦉 *Aviso da Professora Aifos*\nDe: Carlos Souza (Família Souza)\nWhatsApp: +55 31 98888-7777\n\nCarlos pergunta se pode levar a cadeira de rodas da avó.',
    );
    const unknown = formatForward(
      { phone: '5511912345678', display_name: 'Lu', guest_name: null, household: null, verified_by: null },
      'Pediu ajuda.',
      '+55 11 91234-5678',
    );
    expect(unknown).toContain('De: contato fora da lista ("Lu" no WhatsApp)');
  });
});

describe('cliente da Evolution', () => {
  function recorder(response: unknown = { ok: true }, status = 200) {
    const calls: { url: string; init: RequestInit; body: unknown }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(response), { status });
    }) as unknown as typeof fetch;
    const client = createEvolutionClient({ baseUrl: 'https://evo.test/', apiKey: 'k3y', instance: 'convite', fetch: fakeFetch });
    return { calls, client };
  }

  it('monta as chamadas da v2 (texto com "digitando…", reação, lida, mídia)', async () => {
    const { calls, client } = recorder({ base64: 'AAAA', mimetype: 'audio/ogg; codecs=opus' });
    await client.sendText('5531988887777', 'Olá!', 1500.4);
    await client.sendReaction('138@lid', 'MSG1', '❤️');
    await client.markRead('138@lid', ['MSG1', 'MSG2']);
    await client.markRead('138@lid', []);
    expect(await client.downloadMedia('MSG3')).toEqual({ base64: 'AAAA', mimetype: 'audio/ogg; codecs=opus' });

    expect(calls.map((c) => c.url)).toEqual([
      'https://evo.test/message/sendText/convite',
      'https://evo.test/message/sendReaction/convite',
      'https://evo.test/chat/markMessageAsRead/convite',
      'https://evo.test/chat/getBase64FromMediaMessage/convite',
    ]);
    expect(calls[0]!.init.headers).toEqual({ apikey: 'k3y', 'Content-Type': 'application/json' });
    expect(calls.map((c) => c.body)).toEqual([
      { number: '5531988887777', text: 'Olá!', delay: 1500, linkPreview: false },
      { key: { remoteJid: '138@lid', fromMe: false, id: 'MSG1' }, reaction: '❤️' },
      { readMessages: [{ remoteJid: '138@lid', fromMe: false, id: 'MSG1' }, { remoteJid: '138@lid', fromMe: false, id: 'MSG2' }] },
      { message: { key: { id: 'MSG3' } }, convertToMp4: false },
    ]);
  });

  it('erro HTTP vira exceção curta; mídia vazia também', async () => {
    const failing = recorder({ message: 'x'.repeat(1000) }, 500);
    await expect(failing.client.sendText('5531988887777', 'oi')).rejects.toThrow(/sendText: HTTP 500/);
    const empty = recorder({});
    await expect(empty.client.downloadMedia('M')).rejects.toThrow(/sem mídia/);
  });

  it('falha passageira (vale repetir) × falha em que a mensagem pode ter saído', () => {
    const closed = new EvolutionError('/message/sendText', 400, '{"response":{"message":["Error: Connection Closed"]}}');
    expect(isTransientSendError(closed)).toBe(true);
    expect(isTransientSendError(new EvolutionError('/message/sendText', 502, 'Bad Gateway'))).toBe(true);
    expect(isTransientSendError(new EvolutionError('/message/sendText', 429, ''))).toBe(true);
    expect(isTransientSendError(new TypeError('fetch failed'))).toBe(true);
    expect(isTransientSendError(new EvolutionError('/message/sendText', 400, '{"message":["número inválido"]}'))).toBe(false);
    expect(isTransientSendError(new EvolutionError('/message/sendText', 401, 'Unauthorized'))).toBe(false);
    expect(isTransientSendError(new DOMException('Signal timed out.', 'TimeoutError'))).toBe(false);
    expect(isTransientSendError(new Error('qualquer'))).toBe(false);
  });

  it('"digitando…" cresce com o texto, com piso e teto', () => {
    expect(typingDelayMs('Oi')).toBe(1200);
    expect(typingDelayMs('a'.repeat(100))).toBe(3600);
    expect(typingDelayMs('a'.repeat(1000))).toBe(5000);
  });
});

describe('transcrição (OpenAI)', () => {
  it('envia o áudio decodificado como arquivo, em português, com o vocabulário da festa', async () => {
    let form: FormData | null = null;
    let headers: HeadersInit | undefined;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      form = init.body as FormData;
      headers = init.headers;
      return new Response(JSON.stringify({ text: '  Vou com a minha esposa.  ' }));
    }) as unknown as typeof fetch;
    const transcriber = createOpenAiTranscriber({ apiKey: 'sk-test', fetch: fakeFetch });
    const text = await transcriber.transcribe({ base64: btoa('OggS-audio'), mimetype: 'audio/ogg; codecs=opus' });

    expect(text).toBe('Vou com a minha esposa.');
    expect(headers).toEqual({ Authorization: 'Bearer sk-test' });
    const file = form!.get('file') as File;
    expect([file.name, file.type, await file.text()]).toEqual(['audio.ogg', 'audio/ogg', 'OggS-audio']);
    expect(form!.get('model')).toBe('gpt-4o-mini-transcribe');
    expect(form!.get('language')).toBe('pt');
    expect(String(form!.get('prompt'))).toContain('Grifinória');
  });

  it('erro da API vira exceção; base64 com prefixo data: é aceito', async () => {
    const fakeFetch = (async () => new Response('quota', { status: 429 })) as unknown as typeof fetch;
    await expect(createOpenAiTranscriber({ apiKey: 'k', fetch: fakeFetch }).transcribe({ base64: 'AA==', mimetype: 'audio/ogg' })).rejects.toThrow(
      /HTTP 429/,
    );
    expect(Array.from(base64ToBytes(`data:audio/ogg;base64,${btoa('ab')}`))).toEqual([97, 98]);
  });
});

describe('segredo e dependências', () => {
  it('compara segredos sem atalho', () => {
    expect(safeEqual('segredo-longo', 'segredo-longo')).toBe(true);
    expect(safeEqual('segredo-longo', 'segredo-longa')).toBe(false);
    expect(safeEqual('segredo', 'segredo-longo')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });

  it('as Edge Functions fixam as mesmas versões do package.json', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const versions = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
    for (const fn of ['whatsapp-webhook', 'whatsapp-cron']) {
      const { imports } = JSON.parse(readFileSync(`supabase/functions/${fn}/deno.json`, 'utf8')) as { imports: Record<string, string> };
      for (const [name, spec] of Object.entries(imports)) expect(spec).toBe(`npm:${name}@${versions[name]}`);
    }
  });
});

describe('comando "presentes"', () => {
  const gift = (over: Partial<GiftReportEntry> = {}): GiftReportEntry => ({
    gift_name: 'Smartwatch Amazfit GTR 2',
    kind: 'quota',
    status: 'paid',
    payment_method: 'card',
    base_cents: 79_900,
    payer_name: 'Maria Souza',
    signature: 'Tia Maria',
    anonymous: false,
    has_message: true,
    paid_at: '2026-10-19T15:00:00Z',
    ...over,
  });

  it('lista quem deu cada presente; estorno não entra no total; sem nome, aponta o painel', () => {
    const [msg] = formatGiftReport([
      gift(),
      gift({ gift_name: 'Dia de princesa', kind: 'fund', payment_method: 'pix', base_cents: 15_000, payer_name: null, has_message: false, signature: null }),
      gift({ gift_name: 'Fone', base_cents: 27_300, status: 'refunded', anonymous: true, signature: null }),
    ]);
    expect(msg).toBe(
      '🎁 *Presentes pela lista* (2 pagos · R$ 949,00 para a família)\n_Só os organizadores veem os nomes._\n\n' +
        '*Smartwatch Amazfit GTR 2* (R$ 799,00 · cartão · 19/10)\nDe: Maria Souza\n💌 recado assinado "Tia Maria"\n\n' +
        '*Dia de princesa* (R$ 150,00 · vaquinha · Pix · 19/10)\nDe: nome não recebido (veja no painel do Asaas)\n\n' +
        '*Fone* (R$ 273,00 · cartão · 19/10) ↩️ estornado\nDe: Maria Souza\n💌 recado em segredo',
    );
  });

  it('nenhum presente ainda; lista longa vira várias mensagens', () => {
    expect(formatGiftReport([])).toEqual(['🎁 Ainda nenhum presente pago pela lista do site.']);
    const many = formatGiftReport(Array.from({ length: 40 }, () => gift()), 500);
    expect(many.length).toBeGreaterThan(1);
    expect(many.every((m) => m.length <= 500)).toBe(true);
  });
});
