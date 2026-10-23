/**
 * Serviço do Profeta Diário (services/profeta): regras puras, sessão, edição em disco e as rotas
 * sobre um servidor HTTP de verdade, com um ffmpeg falso (o real só existe no container da VPS).
 */
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readConfig, type ProfetaConfig } from '../services/profeta/src/config.ts';
import { createProcessor, parseProbe, photoArgs, videoArgs, type Runner } from '../services/profeta/src/media.ts';
import { cleanText, hasRoom, sniffMedia, uploadWindow } from '../services/profeta/src/rules.ts';
import { createHandler } from '../services/profeta/src/server.ts';
import {
  checkPassword,
  cookieValue,
  createRateLimiter,
  createSession,
  normalizePassword,
  readSession,
  sessionCookie,
} from '../services/profeta/src/session.ts';
import { createStore } from '../services/profeta/src/store.ts';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
const ftyp = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftyp${brand}`), Buffer.alloc(200)]);
const MP4 = ftyp('isom');

describe('regras do Profeta', () => {
  it('reconhece o tipo pela assinatura, não pela extensão', () => {
    expect(sniffMedia(JPEG)).toEqual({ kind: 'foto', mime: 'image/jpeg' });
    expect(sniffMedia(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))?.mime).toBe('image/png');
    expect(sniffMedia(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))?.mime).toBe('image/webp');
    expect(sniffMedia(ftyp('heic'))).toEqual({ kind: 'foto', mime: 'image/heic' });
    expect(sniffMedia(MP4)).toEqual({ kind: 'video', mime: 'video/mp4' });
    expect(sniffMedia(ftyp('qt  '))).toEqual({ kind: 'video', mime: 'video/quicktime' });
    expect(sniffMedia(ftyp('3gp4'))?.kind).toBe('video');
    for (const bad of [Buffer.from('<html>'), Buffer.from('%PDF-1.7'), Buffer.from('GIF89a'), Buffer.alloc(0), ftyp('xxxx')]) {
      expect(sniffMedia(bad)).toBeNull();
    }
  });

  it('janela de envio: antes, aberta e fechada', () => {
    const opens = new Date('2027-02-20T00:00:00-03:00');
    const closes = new Date('2027-03-07T00:00:00-03:00');
    expect(uploadWindow(new Date('2027-02-19T23:59:59-03:00'), opens, closes)).toBe('antes');
    expect(uploadWindow(opens, opens, closes)).toBe('aberta');
    expect(uploadWindow(closes, opens, closes)).toBe('fechada');
  });

  it('cota: respeita o teto do Profeta e a reserva do disco', () => {
    const base = { usedBytes: 900, quotaBytes: 1000, freeBytes: 10_000, reserveBytes: 500 };
    expect(hasRoom(base, 100)).toBe(true);
    expect(hasRoom(base, 101)).toBe(false);
    expect(hasRoom({ ...base, freeBytes: 550 }, 100)).toBe(false);
    expect(hasRoom({ ...base, freeBytes: null }, 100)).toBe(true);
  });

  it('textos de fora: sem controles, espaços colapsados, cortados', () => {
    expect(cleanText('  Tia\u0000  Marta ‮ ', 60)).toBe('Tia Marta');
    expect(cleanText('   ', 60)).toBeNull();
    expect(cleanText(42, 60)).toBeNull();
    expect(cleanText('😀'.repeat(10), 3)).toBe('😀😀😀');
  });
});

describe('sessão do Profeta', () => {
  const SECRET = 's'.repeat(40);

  it('palavra mágica sem acento, maiúscula ou espaço extra', () => {
    expect(normalizePassword('  Lúmos   MÁXIMA ')).toBe('lumos maxima');
    expect(checkPassword('lumos maxima', 'Lúmos Máxima')).toBe(true);
    expect(checkPassword('lumos', 'Lúmos Máxima')).toBe(false);
    expect(checkPassword(undefined, 'Lúmos Máxima')).toBe(false);
    expect(checkPassword('x'.repeat(500), 'Lúmos Máxima')).toBe(false);
  });

  it('cookie assinado: vale até expirar, não aceita adulteração nem outro segredo', () => {
    const now = Date.UTC(2027, 1, 20);
    const { token, session } = createSession(SECRET, now);
    expect(readSession(token, SECRET, now + 1000)).toEqual(session);
    expect(readSession(token, 'o'.repeat(40), now)).toBeNull();
    expect(readSession(token, SECRET, session.exp)).toBeNull();
    const [payload, mac] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sid: 'x', exp: now * 2 })).toString('base64url');
    expect(readSession(`${forged}.${mac}`, SECRET, now)).toBeNull();
    expect(readSession(`${payload}.${mac}.x`, SECRET, now)).toBeNull();
    expect(readSession(null, SECRET, now)).toBeNull();
  });

  it('cookie httpOnly, seguro, restrito a /api/profeta', () => {
    const header = sessionCookie('abc');
    expect(header).toMatch(/^profeta=abc; Path=\/api\/profeta; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/);
    expect(cookieValue('a=1; profeta=abc.def; b=2')).toBe('abc.def');
    expect(cookieValue('a=1')).toBeNull();
  });

  it('limite de tentativas por chave, em janela deslizante', () => {
    const limit = createRateLimiter(2, 1000);
    expect(limit.take('ip', 0)).toBe(true);
    expect(limit.take('ip', 10)).toBe(true);
    expect(limit.take('ip', 20)).toBe(false);
    expect(limit.take('outro', 20)).toBe(true);
    expect(limit.take('ip', 1001)).toBe(true);
  });
});

describe('ffmpeg', () => {
  it('foto: sem metadados, até 2560 px e miniatura de 640 px, uma thread', () => {
    const [big, mini] = photoArgs('in', 'g.jpg', 'm.webp');
    expect(big).toEqual(expect.arrayContaining(['-map_metadata', '-1', '-threads', '1']));
    expect(big!.join(' ')).toContain('min(2560,iw)');
    expect(mini!.join(' ')).toContain('min(640,iw)');
    expect(big!.at(-1)).toBe('g.jpg');
  });

  it('vídeo: corta em 15 s, 720p H.264 com faststart, sem metadados', () => {
    const [video, poster] = videoArgs('in', 'v.mp4', 'p.webp');
    const text = video!.join(' ');
    expect(text).toContain('-t 15');
    expect(text).toContain('min(1280,iw)');
    expect(text).toContain('-c:v libx264');
    expect(text).toContain('+faststart');
    expect(text).toContain('-map_metadata -1');
    expect(text).toContain('0:a:0?');
    expect(poster!.at(-1)).toBe('p.webp');
  });

  it('lê largura e altura do ffprobe', () => {
    expect(parseProbe('{"streams":[{"width":1280,"height":720}]}')).toEqual({ width: 1280, height: 720 });
    expect(parseProbe('{"streams":[]}')).toBeNull();
    expect(parseProbe('lixo')).toBeNull();
  });
});

// ---- Servidor de verdade, com ffmpeg falso -------------------------------------------------------

/** ffmpeg falso: escreve 1 KB no arquivo de saída (último argumento); ffprobe responde 1280×720. */
const fakeRun: Runner = async (cmd, args) => {
  if (cmd === 'ffprobe') return '{"streams":[{"width":1280,"height":720}]}';
  if (args.some((a) => a.endsWith('quebrar'))) throw new Error('arquivo corrompido');
  fs.writeFileSync(args.at(-1)!, Buffer.alloc(1024, 7));
  return '';
};

let dir: string;
let server: Server;
let base: string;
let clock: Date;
let config: ProfetaConfig;
let store: ReturnType<typeof createStore>;
let downloads: string[];

async function start(overrides: Partial<ProfetaConfig> = {}, waMedia: Buffer = JPEG) {
  config = {
    ...readConfig({
      PROFETA_SENHA: 'Lúmos Máxima',
      PROFETA_SESSAO_SEGREDO: 'k'.repeat(40),
      PROFETA_SECRET: 'i'.repeat(40),
      PROFETA_ABRE_EM: '2027-02-20T00:00:00-03:00',
      PROFETA_FECHA_EM: '2027-03-07T00:00:00-03:00',
      PROFETA_DADOS: dir,
    }),
    ...overrides,
  };
  const dirs = { tmp: path.join(dir, 'tmp'), media: path.join(dir, 'midia') };
  fs.mkdirSync(dirs.tmp, { recursive: true });
  fs.mkdirSync(dirs.media, { recursive: true });
  store = createStore(dir, () => clock);
  const processor = createProcessor(store, dirs, fakeRun, { error: () => {} } as unknown as Console);
  downloads = [];
  const handler = createHandler({
    config,
    store,
    processor,
    dirs,
    now: () => clock,
    freeBytes: async () => 50 * 1024 ** 3,
    downloadWhatsApp: async (id) => {
      downloads.push(id);
      return waMedia;
    },
    log: { error: () => {}, warn: () => {} },
  });
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/profeta`;
}

const WRITE = { 'x-profeta': '1' };
const INTERNAL = { 'x-profeta-secret': 'i'.repeat(40), 'content-type': 'application/json' };

async function login(senha = 'lumos maxima'): Promise<string> {
  const res = await fetch(`${base}/entrar`, { method: 'POST', headers: { ...WRITE, 'content-type': 'application/json' }, body: JSON.stringify({ senha }) });
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe('rotas do Profeta', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profeta-'));
    clock = new Date('2027-02-20T22:00:00-03:00');
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sem a palavra mágica não entra, não lê a edição nem envia', async () => {
    await start();
    expect((await fetch(`${base}/saude`)).status).toBe(200);
    expect(await (await fetch(`${base}/sessao`)).json()).toMatchObject({ entrou: false, janela: 'aberta' });
    const wrong = await fetch(`${base}/entrar`, { method: 'POST', headers: { ...WRITE, 'content-type': 'application/json' }, body: '{"senha":"alohomora"}' });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: 'senha_errada' });
    expect((await fetch(`${base}/edicao`)).status).toBe(401);
    expect((await fetch(`${base}/enviar?tipo=foto`, { method: 'POST', headers: WRITE, body: JPEG })).status).toBe(401);
  });

  it('POST sem o cabeçalho x-profeta é recusado (outro site não consegue enviar)', async () => {
    await start();
    const res = await fetch(`${base}/entrar`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"senha":"lumos maxima"}' });
    expect(res.status).toBe(403);
  });

  it('limita tentativas da senha por IP', async () => {
    await start();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await fetch(`${base}/entrar`, { method: 'POST', headers: { ...WRITE, 'x-real-ip': '10.0.0.9' }, body: '{"senha":"errada"}' });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('envio pelo site: foto entra na fila, vira "pronta" e aparece na edição com número e autor', async () => {
    await start();
    const cookie = await login();
    const res = await fetch(`${base}/enviar?tipo=foto&autor=${encodeURIComponent('Tia Marta')}&legenda=Brinde`, {
      method: 'POST',
      headers: { ...WRITE, cookie, 'content-type': 'image/jpeg' },
      body: JPEG,
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, n: 1 });
    await settle();

    const edition = (await (await fetch(`${base}/edicao`, { headers: { cookie } })).json()) as { v: number; itens: { mini: string; grande: string }[] };
    expect(edition).toMatchObject({ mudou: true, janela: 'aberta', itens: [{ n: 1, tipo: 'foto', autor: 'Tia Marta', legenda: 'Brinde', w: 1280, h: 720, video: null }] });
    expect(await (await fetch(`${base}/edicao?v=${edition.v}`, { headers: { cookie } })).json()).toEqual({ mudou: false, v: edition.v });

    const mini = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${edition.itens[0]!.mini}`, { headers: { cookie } });
    expect(mini.status).toBe(200);
    expect(mini.headers.get('content-type')).toBe('image/webp');
    expect(mini.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    const noCookie = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${edition.itens[0]!.grande}`);
    expect(noCookie.status).toBe(401);
    expect(fs.readdirSync(path.join(dir, 'tmp'))).toEqual([]);
  });

  it('vídeo com Range (o Safari só toca assim)', async () => {
    await start();
    const cookie = await login();
    expect((await fetch(`${base}/enviar?tipo=video`, { method: 'POST', headers: { ...WRITE, cookie }, body: MP4 })).status).toBe(202);
    await settle();
    const { itens } = (await (await fetch(`${base}/edicao`, { headers: { cookie } })).json()) as { itens: { video: string }[] };
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${itens[0]!.video}`, { headers: { cookie, range: 'bytes=0-99' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-99/1024');
    expect((await res.arrayBuffer()).byteLength).toBe(100);
  });

  it('recusa arquivo disfarçado, tipo trocado e envio fora da janela', async () => {
    await start();
    const cookie = await login();
    const post = (tipo: string, body: Buffer<ArrayBuffer>) => fetch(`${base}/enviar?tipo=${tipo}`, { method: 'POST', headers: { ...WRITE, cookie }, body });
    expect((await post('foto', Buffer.from('<html><script>alert(1)</script></html>'))).status).toBe(415);
    expect((await post('foto', MP4)).status).toBe(415);
    expect((await post('gif', JPEG)).status).toBe(400);
    clock = new Date('2027-02-19T12:00:00-03:00');
    const early = await post('foto', JPEG);
    expect(early.status).toBe(403);
    expect(await early.json()).toEqual({ error: 'janela_antes' });
    expect(store.all()).toEqual([]);
    expect(fs.readdirSync(path.join(dir, 'tmp'))).toEqual([]);
  });

  it('sem espaço na cota: recusa com 507 e não guarda nada', async () => {
    await start({ quotaBytes: 100 });
    const cookie = await login();
    const res = await fetch(`${base}/enviar?tipo=foto`, { method: 'POST', headers: { ...WRITE, cookie }, body: JPEG });
    expect(res.status).toBe(507);
    expect(await res.json()).toEqual({ error: 'sem_espaco' });
    expect(store.all()).toEqual([]);
  });

  it('WhatsApp: baixa uma vez, guarda o autor e ignora repetição', async () => {
    await start({}, MP4);
    expect((await fetch(`${base}/interno/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"waMessageId":"ABC"}' })).status).toBe(401);
    const send = () =>
      fetch(`${base}/interno/whatsapp`, { method: 'POST', headers: INTERNAL, body: JSON.stringify({ waMessageId: 'ABC123', autor: 'João Souza', legenda: 'Valsa!' }) });
    const first = await send();
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ ok: true, n: 1, tipo: 'video' });
    expect(await (await send()).json()).toEqual({ ok: true, n: 1, repetida: true });
    expect(downloads).toEqual(['ABC123']);
    await settle();
    expect(store.get(1)).toMatchObject({ status: 'pronta', source: 'whatsapp', author: 'João Souza', caption: 'Valsa!', kind: 'video' });
  });

  it('retirar e devolver pelo organizador; retirada some da edição e a mídia deixa de abrir', async () => {
    await start();
    const cookie = await login();
    await fetch(`${base}/enviar?tipo=foto`, { method: 'POST', headers: { ...WRITE, cookie }, body: JPEG });
    await settle();
    const mini = store.publicItems()[0]!.mini;
    const out = await fetch(`${base}/interno/retirar`, { method: 'POST', headers: INTERNAL, body: '{"n":1}' });
    expect(await out.json()).toMatchObject({ ok: true, n: 1, retirada: true, mudou: true });
    expect(store.publicItems()).toEqual([]);
    expect((await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${mini}`, { headers: { cookie } })).status).toBe(404);
    const summary = (await (await fetch(`${base}/interno/resumo`, { headers: INTERNAL })).json()) as Record<string, unknown>;
    expect(summary).toMatchObject({ total: 1, fotos: 0, retirados: 1, ultimos: [{ n: 1, retirado: true }] });
    await fetch(`${base}/interno/devolver`, { method: 'POST', headers: INTERNAL, body: '{"n":1}' });
    expect(store.publicItems()).toHaveLength(1);
    expect((await fetch(`${base}/interno/retirar`, { method: 'POST', headers: INTERNAL, body: '{"n":99}' })).status).toBe(404);
  });

  it('falha no ffmpeg: item marcado como falhou, nada publicado, bruto apagado', async () => {
    await start();
    const cookie = await login();
    // O nome do bruto não controla o ffmpeg; simulamos a falha pelo próprio runner.
    const n = store.add({ kind: 'foto', source: 'site', author: null, caption: null, waMessageId: null, rawFile: 'quebrar', rawBytes: 10 }).n;
    fs.writeFileSync(path.join(dir, 'tmp', 'quebrar'), JPEG);
    const processor = createProcessor(store, { tmp: path.join(dir, 'tmp'), media: path.join(dir, 'midia') }, fakeRun, { error: () => {} } as unknown as Console);
    processor.enqueue(n);
    await settle();
    expect(store.get(n)?.status).toBe('falhou');
    expect(fs.readdirSync(path.join(dir, 'tmp'))).toEqual([]);
    expect((await (await fetch(`${base}/edicao`, { headers: { cookie } })).json()).itens).toEqual([]);
  });

  it('a edição sobrevive a um reinício (edicao.json atômico)', async () => {
    await start();
    const cookie = await login();
    await fetch(`${base}/enviar?tipo=foto&autor=Ana`, { method: 'POST', headers: { ...WRITE, cookie }, body: JPEG });
    await settle();
    const reloaded = createStore(dir);
    expect(reloaded.publicItems()).toMatchObject([{ n: 1, autor: 'Ana' }]);
    expect(reloaded.add({ kind: 'foto', source: 'site', author: null, caption: null, waMessageId: null, rawFile: null, rawBytes: 0 }).n).toBe(2);
    expect(fs.existsSync(path.join(dir, 'edicao.json.tmp'))).toBe(false);
  });
});

describe('configuração do serviço', () => {
  const env = {
    PROFETA_SENHA: 'lumos',
    PROFETA_SESSAO_SEGREDO: 'k'.repeat(32),
    PROFETA_SECRET: 'i'.repeat(32),
    PROFETA_ABRE_EM: '2027-02-20T00:00:00-03:00',
    PROFETA_FECHA_EM: '2027-03-07T00:00:00-03:00',
  };

  it('exige segredos longos e datas coerentes; cota em GB', () => {
    expect(readConfig({ ...env, PROFETA_COTA_GB: '2,5' }).quotaBytes).toBe(2.5 * 1024 ** 3);
    expect(readConfig(env).evolution).toBeNull();
    expect(() => readConfig({ ...env, PROFETA_SECRET: 'curto' })).toThrow(/PROFETA_SECRET/);
    expect(() => readConfig({ ...env, PROFETA_SENHA: '' })).toThrow(/PROFETA_SENHA/);
    expect(() => readConfig({ ...env, PROFETA_FECHA_EM: '2027-01-01' })).toThrow(/depois/);
    expect(() => readConfig({ ...env, PROFETA_ABRE_EM: 'amanhã' })).toThrow(/data/);
    expect(() => readConfig({ ...env, EVOLUTION_API_URL: 'http://evolution:8080' })).toThrow(/EVOLUTION_API_KEY/);
  });
});
