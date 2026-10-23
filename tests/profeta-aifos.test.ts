/**
 * O Profeta Diário do lado da Aifos (Edge Functions): comandos dos organizadores, cliente das rotas
 * internas do serviço (sem rede) e o vídeo do WhatsApp com tipo próprio.
 */
import { describe, expect, it } from 'vitest';
import { formatInbound } from '../supabase/functions/_shared/agent/context.ts';
import { parseUpsert } from '../supabase/functions/_shared/whatsapp/inbound.ts';
import { createProfetaClient, isPhotosCommand, parsePhotoCommand, PROFETA_REPLIES } from '../supabase/functions/_shared/whatsapp/profeta.ts';
import { formatProfetaRemoval } from '../supabase/functions/_shared/whatsapp/report.ts';

describe('comandos do Profeta', () => {
  it('"fotos" (já normalizado pelo bot)', () => {
    for (const ok of ['fotos', 'foto', '/fotos']) expect(isPhotosCommand(ok), ok).toBe(true);
    for (const no of ['fotos da festa', 'minhas fotos', '']) expect(isPhotosCommand(no), no).toBe(false);
  });

  it('"retirar foto N" / "devolver foto N", com variações; "retirar N" continua sendo das cartas', () => {
    expect(parsePhotoCommand('retirar foto 7')).toEqual({ removed: true, n: 7 });
    expect(parsePhotoCommand('Retirar a foto nº 12.')).toEqual({ removed: true, n: 12 });
    expect(parsePhotoCommand('retirar o vídeo #3')).toEqual({ removed: true, n: 3 });
    expect(parsePhotoCommand('DEVOLVER FOTOGRAFIA 40!')).toEqual({ removed: false, n: 40 });
    for (const no of ['retirar 7', 'retirar foto', 'retirar foto sete', 'apagar foto 7', 'retirar foto 7 e 8']) {
      expect(parsePhotoCommand(no), no).toBeNull();
    }
  });

  it('respostas no singular, plural e com vídeo', () => {
    expect(PROFETA_REPLIES.sent(1, 0, null)).toContain('Sua fotografia foi capturada e já voa');
    expect(PROFETA_REPLIES.sent(1, 1, null)).toContain('Seu vídeo foi capturado');
    expect(PROFETA_REPLIES.sent(4, 1, 'https://x/profeta/')).toContain('4 lembranças capturadas e já voam');
    expect(PROFETA_REPLIES.sent(4, 1, 'https://x/profeta/')).toContain('https://x/profeta/');
    expect(formatProfetaRemoval(5, true, { ok: true, n: 5, tipo: 'video', autor: null, retirada: true, mudou: true })).toBe(
      'Vídeo Nº 5 retirado do Profeta Diário. Some da página na próxima atualização.',
    );
    expect(formatProfetaRemoval(5, true, { ok: true, n: 5, tipo: 'foto', autor: 'Ana', retirada: true, mudou: false })).toBe(
      'Foto Nº 5 (de Ana) já estava fora do jornal.',
    );
    expect(formatProfetaRemoval(5, true, { ok: false, error: 'indisponivel' })).toBe('O Profeta Diário não respondeu agora. Tente de novo em instantes.');
  });
});

describe('cliente das rotas internas do Profeta', () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (status: number, body: unknown) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

  it('manda o id da mensagem com o segredo; devolve o número no jornal', async () => {
    calls.length = 0;
    const client = createProfetaClient({ apiUrl: 'https://site.test/api/profeta/', secret: 'x'.repeat(40), fetch: fakeFetch(202, { ok: true, n: 9, tipo: 'video' }) });
    expect(await client.sendFromWhatsApp({ waMessageId: 'ABC', author: 'Ana', caption: null })).toEqual({ ok: true, n: 9, tipo: 'video', repetida: false });
    expect(calls[0]!.url).toBe('https://site.test/api/profeta/interno/whatsapp');
    expect((calls[0]!.init.headers as Record<string, string>)['x-profeta-secret']).toBe('x'.repeat(40));
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ waMessageId: 'ABC', autor: 'Ana', legenda: null });
  });

  it('recusa e queda de rede viram erro, nunca sucesso', async () => {
    const refused = createProfetaClient({ apiUrl: 'https://site.test/api/profeta', secret: 's', fetch: fakeFetch(403, { error: 'janela_antes' }) });
    expect(await refused.sendFromWhatsApp({ waMessageId: 'A', author: 'Ana', caption: null })).toEqual({ ok: false, error: 'janela_antes' });
    const down = createProfetaClient({
      apiUrl: 'https://site.test/api/profeta',
      secret: 's',
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    expect(await down.sendFromWhatsApp({ waMessageId: 'A', author: 'Ana', caption: null })).toEqual({ ok: false, error: 'indisponivel' });
    expect(await down.setRemoved(1, true)).toEqual({ ok: false, error: 'indisponivel' });
    await expect(down.summary()).rejects.toThrow();
  });
});

describe('vídeo do WhatsApp', () => {
  it('videoMessage vira o tipo video (com a legenda); a Aifos sabe que recebeu um vídeo', () => {
    const parsed = parseUpsert(
      {
        event: 'messages.upsert',
        instance: 'convite',
        data: {
          key: { id: 'V1', fromMe: false, remoteJid: '5531988887777@s.whatsapp.net' },
          message: { videoMessage: { mimetype: 'video/mp4', seconds: 9, caption: 'A valsa' } },
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      },
      { instance: 'convite' },
    );
    expect(parsed.ok && [parsed.message.kind, parsed.message.body]).toEqual(['video', 'A valsa']);
    expect(formatInbound([{ waMessageId: 'V1', kind: 'video', text: null }])).toBe('[enviou um vídeo]');
  });
});
