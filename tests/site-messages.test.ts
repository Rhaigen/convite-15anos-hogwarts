/**
 * Edge Function site-messages (O Salão Principal), sobre o banco real (PGlite):
 * só aprovados, selo aplicado no banco, CORS só do convite, cache curto e erro genérico.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_PHONES } from '../scripts/lib/pglite-db.ts';
import {
  createSiteMessagesHandler,
  parseOrigins,
  toWallResponse,
} from '../supabase/functions/_shared/siteMessages/handler.ts';
import { createTestDb, type TestDb } from './support/agent.ts';

const SITE = 'https://convite.example';
let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});

beforeEach(async () => {
  await t.reset();
  await t.db.exec(`update public.message_wall_settings set unseal_at = '2027-02-20 00:00:00-03' where id = 1`);
});

async function saveAndApprove(phone: string, body: string, signature: string | null) {
  await t.rpc('bot_save_guest_message', { p_phone: phone, p_body: body, p_signature: signature, p_source: 'text', p_wa_message_id: null });
  const list = (await t.rpc('bot_guest_messages', {})) as { id: number; body: string }[];
  const id = list.find((m) => m.body === body)!.id;
  await t.rpc('bot_set_message_approval', { p_id: id, p_approved: true });
}

const get = (origin: string | null = SITE, method = 'GET') =>
  new Request('https://fn.test/site-messages', { method, headers: origin ? { Origin: origin } : {} });

describe('site-messages', () => {
  it('selada: só remetentes, nada do texto; CORS e cache para o convite', async () => {
    await saveAndApprove(DEMO_PHONES.carlos, 'Segredo até a festa', 'Tio Carlos');
    await saveAndApprove(DEMO_PHONES.joao, 'Outro segredo', null);
    await t.rpc('bot_save_guest_message', { p_phone: DEMO_PHONES.marta, p_body: 'Não aprovado', p_signature: null, p_source: 'text', p_wa_message_id: null });

    const handler = createSiteMessagesHandler({ rpc: t.rpc, allowedOrigins: [SITE] });
    const res = await handler(get());
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(SITE);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    const text = await res.text();
    expect(text).not.toMatch(/segredo|Não aprovado|Souza|Barbosa|Marta/i);
    expect(JSON.parse(text)).toEqual({
      sealed: true,
      unsealAt: expect.stringMatching(/^2027-02-20/),
      letters: [
        { id: expect.any(String), from: 'Tio Carlos' },
        { id: expect.any(String), from: 'João' },
      ],
    });
  });

  it('aberta: o texto vem junto, na ordem de aprovação', async () => {
    await t.db.exec(`update public.message_wall_settings set unseal_at = '2000-01-01 00:00:00+00' where id = 1`);
    await saveAndApprove(DEMO_PHONES.carlos, 'Sofia, você é a nossa estrela!\n\nCom carinho.', 'Tio Carlos');
    const handler = createSiteMessagesHandler({ rpc: t.rpc, allowedOrigins: [SITE] });
    const body = await (await handler(get())).json();
    expect(body.sealed).toBe(false);
    expect(body.letters).toEqual([{ id: expect.any(String), from: 'Tio Carlos', body: 'Sofia, você é a nossa estrela!\n\nCom carinho.' }]);
  });

  it('outra origem não recebe CORS; métodos além de GET/OPTIONS são recusados', async () => {
    const handler = createSiteMessagesHandler({ rpc: t.rpc, allowedOrigins: [SITE] });
    expect((await handler(get('https://outro.example'))).headers.get('Access-Control-Allow-Origin')).toBeNull();
    const pre = await handler(get(SITE, 'OPTIONS'));
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
    expect((await handler(get(SITE, 'POST'))).status).toBe(405);
  });

  it('cache na memória da função; erro vira 503 genérico, sem detalhes', async () => {
    let calls = 0;
    let now = 0;
    const logs: string[] = [];
    const handler = createSiteMessagesHandler({
      rpc: async () => {
        calls++;
        if (calls > 1) throw new Error('relation "segredo" does not exist');
        return { sealed: true, unseal_at: '2027-02-20T03:00:00+00:00', letters: [] };
      },
      allowedOrigins: [SITE],
      clock: () => now,
      log: (event) => logs.push(event),
    });
    await handler(get());
    await handler(get());
    expect(calls).toBe(1);

    now = 61_000;
    const res = await handler(get());
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.text()).toBe('{"error":"unavailable"}');
    expect(logs).toEqual(['site_messages_failed']);
  });
});

describe('toWallResponse e parseOrigins', () => {
  it('descarta campos extras e itens fora do formato', () => {
    expect(
      toWallResponse({
        sealed: false,
        unseal_at: '2027-02-20T03:00:00+00:00',
        letters: [
          { id: 'a', from: 'Ana', body: 'Oi', full_name: 'Ana Souza', phone: '5531' },
          { id: 'b', from: '' , body: 'x' },
          { id: 'c', from: 'Caio' },
          null,
        ],
      }),
    ).toEqual({ sealed: false, unsealAt: '2027-02-20T03:00:00+00:00', letters: [{ id: 'a', from: 'Ana', body: 'Oi' }] });
    // Na dúvida, selada: sem o campo, nenhum texto passa.
    expect(toWallResponse({ letters: [{ id: 'a', from: 'Ana', body: 'Oi' }] })).toMatchObject({ sealed: true, letters: [{ id: 'a', from: 'Ana' }] });
    expect(toWallResponse(null)).toEqual({ sealed: true, unsealAt: '', letters: [] });
  });

  it('origens: normaliza a barra final e ignora o que não é origem', () => {
    expect(parseOrigins(' https://a.com/, http://localhost:5173 ,*, https://b.com/caminho, ')).toEqual(['https://a.com', 'http://localhost:5173']);
    expect(parseOrigins(undefined)).toEqual([]);
  });
});
