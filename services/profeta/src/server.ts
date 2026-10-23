/**
 * Rotas do Profeta Diário (atrás do Traefik, no mesmo domínio do convite: /api/profeta/*).
 *
 * Públicas (com a palavra mágica → cookie):
 *   GET  /api/profeta/saude              conferência (sem sessão)
 *   GET  /api/profeta/sessao             { entrou, janela, abreEm, fechaEm }
 *   POST /api/profeta/entrar             { senha } → cookie
 *   GET  /api/profeta/edicao?v=N         lista publicada (ou { mudou:false } se a versão é a mesma)
 *   POST /api/profeta/enviar?tipo=&autor=&legenda=   corpo = o arquivo (um por pedido)
 *   GET  /api/profeta/midia/<arquivo>    foto/vídeo/miniatura (com Range)
 * Internas (cabeçalho x-profeta-secret; quem chama é a whatsapp-webhook):
 *   POST /api/profeta/interno/whatsapp   { waMessageId, autor, legenda } → baixa da Evolution
 *   GET  /api/profeta/interno/resumo     números para o comando "fotos"
 *   POST /api/profeta/interno/retirar    { n }   /  .../devolver { n }
 *
 * Nenhuma resposta de erro traz detalhe interno; os POSTs públicos exigem o cabeçalho
 * x-profeta: 1 (outro site não consegue mandá-lo sem permissão de CORS, que não existe).
 */
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import type { ProfetaConfig } from './config.ts';
import type { Processor } from './media.ts';
import { MAX_RAW_BYTES, cleanText, hasRoom, sniffMedia, uploadWindow, type MediaKind } from './rules.ts';
import { checkPassword, cookieValue, createRateLimiter, createSession, readSession, sameSecret, sessionCookie } from './session.ts';
import type { Item, Store } from './store.ts';

export interface ServerDeps {
  config: ProfetaConfig;
  store: Store;
  processor: Processor;
  dirs: { tmp: string; media: string };
  now?: () => Date;
  /** Espaço livre real no disco do Profeta (statfs). */
  freeBytes?: () => Promise<number | null>;
  /** Baixa a mídia de uma mensagem do WhatsApp (Evolution, rede interna da VPS). */
  downloadWhatsApp?: (waMessageId: string) => Promise<Buffer>;
  log?: Pick<Console, 'error' | 'warn'>;
}

const AUTHOR_MAX = 60;
const CAPTION_MAX = 140;
const JSON_MAX = 4096;

const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4' };
const MEDIA_NAME = /^[a-f0-9]{20}-(g\.jpg|m\.webp|p\.webp|v\.mp4)$/;

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function send(req: IncomingMessage, res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  let payload: Buffer = Buffer.from(JSON.stringify(body));
  const extra: Record<string, string> = {};
  if (payload.length > 2048 && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
    payload = gzipSync(payload);
    extra['Content-Encoding'] = 'gzip';
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Accept-Encoding',
    ...extra,
    ...headers,
  });
  res.end(req.method === 'HEAD' ? undefined : payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > JSON_MAX) throw new HttpError(413, 'grande_demais');
    chunks.push(chunk as Buffer);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  } catch {
    /* cai no erro abaixo */
  }
  throw new HttpError(400, 'pedido_invalido');
}

/** IP do convidado: o Traefik põe X-Real-Ip; sem ele, o primeiro do X-Forwarded-For. */
function clientIp(req: IncomingMessage): string {
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real) return real.trim();
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? '?';
}

export function createHandler(deps: ServerDeps) {
  const { config, store, processor, dirs } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? console;
  const freeBytes = deps.freeBytes ?? (async () => null);
  const loginLimit = createRateLimiter(10, 10 * 60_000);
  const uploadLimit = createRateLimiter(40, 60_000);

  const windowState = () => uploadWindow(now(), config.opensAt, config.closesAt);
  const windowInfo = () => ({ janela: windowState(), abreEm: config.opensAt.toISOString(), fechaEm: config.closesAt.toISOString() });
  const session = (req: IncomingMessage) => readSession(cookieValue(req.headers.cookie), config.sessionSecret, now().getTime());

  const requireSession = (req: IncomingMessage) => {
    const s = session(req);
    if (!s) throw new HttpError(401, 'sem_sessao');
    return s;
  };
  const requireInternal = (req: IncomingMessage) => {
    const given = req.headers['x-profeta-secret'];
    if (typeof given !== 'string' || !sameSecret(given, config.internalSecret)) throw new HttpError(401, 'nao_autorizado');
  };
  const requireSameSiteWrite = (req: IncomingMessage) => {
    if (req.headers['x-profeta'] !== '1') throw new HttpError(403, 'pedido_invalido');
  };

  async function assertRoom(incoming: number) {
    const ok = hasRoom({ usedBytes: store.usedBytes(), quotaBytes: config.quotaBytes, freeBytes: await freeBytes(), reserveBytes: config.reserveBytes }, incoming);
    if (!ok) throw new HttpError(507, 'sem_espaco');
  }

  /** Guarda o bruto em tmp/, confere a assinatura e põe na fila. Apaga o bruto se recusar. */
  function accept(rawName: string, rawBytes: number, expected: MediaKind | null, meta: { source: Item['source']; author: string | null; caption: string | null; waMessageId: string | null }): Item {
    const rawPath = path.join(dirs.tmp, rawName);
    const head = Buffer.alloc(32);
    const fd = fs.openSync(rawPath, 'r');
    try {
      fs.readSync(fd, head, 0, 32, 0);
    } finally {
      fs.closeSync(fd);
    }
    const sniffed = sniffMedia(head);
    if (!sniffed || (expected && sniffed.kind !== expected) || rawBytes > MAX_RAW_BYTES[sniffed.kind]) {
      fs.rmSync(rawPath, { force: true });
      throw new HttpError(sniffed && rawBytes > MAX_RAW_BYTES[sniffed.kind] ? 413 : 415, sniffed ? 'grande_demais' : 'formato_nao_aceito');
    }
    const item = store.add({ kind: sniffed.kind, rawFile: rawName, rawBytes, ...meta });
    processor.enqueue(item.n);
    return item;
  }

  async function upload(req: IncomingMessage, res: ServerResponse, url: URL) {
    requireSameSiteWrite(req);
    const s = requireSession(req);
    if (windowState() !== 'aberta') throw new HttpError(403, `janela_${windowState()}`);
    if (!uploadLimit.take(s.sid)) throw new HttpError(429, 'devagar');
    const tipo = url.searchParams.get('tipo');
    if (tipo !== 'foto' && tipo !== 'video') throw new HttpError(400, 'pedido_invalido');
    const limit = MAX_RAW_BYTES[tipo];
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'grande_demais');
    await assertRoom(Number.isFinite(declared) && declared > 0 ? declared : limit);

    const rawName = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.bruto`;
    const rawPath = path.join(dirs.tmp, rawName);
    let size = 0;
    const out = fs.createWriteStream(rawPath, { flags: 'wx' });
    try {
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > limit) throw new HttpError(413, 'grande_demais');
        if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    } catch (error) {
      out.destroy();
      fs.rmSync(rawPath, { force: true });
      throw error;
    }
    if (size === 0) {
      fs.rmSync(rawPath, { force: true });
      throw new HttpError(400, 'pedido_invalido');
    }
    const item = accept(rawName, size, tipo, {
      source: 'site',
      author: cleanText(url.searchParams.get('autor'), AUTHOR_MAX),
      caption: cleanText(url.searchParams.get('legenda'), CAPTION_MAX),
      waMessageId: null,
    });
    send(req, res, 202, { ok: true, n: item.n });
  }

  async function fromWhatsApp(req: IncomingMessage, res: ServerResponse) {
    requireInternal(req);
    const body = await readJson(req);
    const waMessageId = cleanText(body.waMessageId, 128);
    if (!waMessageId || !/^[\w-]+$/.test(waMessageId)) throw new HttpError(400, 'pedido_invalido');
    const existing = store.byWaMessageId(waMessageId);
    if (existing) return send(req, res, 200, { ok: true, n: existing.n, repetida: true });
    if (windowState() !== 'aberta') throw new HttpError(403, `janela_${windowState()}`);
    if (!deps.downloadWhatsApp) throw new HttpError(503, 'indisponivel');
    await assertRoom(MAX_RAW_BYTES.video);

    let data: Buffer;
    try {
      data = await deps.downloadWhatsApp(waMessageId);
    } catch (error) {
      log.error('profeta: não consegui baixar a mídia do WhatsApp:', error instanceof Error ? error.message : error);
      throw new HttpError(502, 'download_falhou');
    }
    const rawName = `${Date.now()}-wa-${Math.random().toString(36).slice(2, 10)}.bruto`;
    fs.writeFileSync(path.join(dirs.tmp, rawName), data, { flag: 'wx' });
    const item = accept(rawName, data.length, null, {
      source: 'whatsapp',
      author: cleanText(body.autor, AUTHOR_MAX),
      caption: cleanText(body.legenda, CAPTION_MAX),
      waMessageId,
    });
    send(req, res, 202, { ok: true, n: item.n, tipo: item.kind });
  }

  function summary() {
    const items = store.all();
    const ready = items.filter((i) => i.status === 'pronta');
    return {
      total: ready.length,
      fotos: ready.filter((i) => i.kind === 'foto' && !i.removedAt).length,
      videos: ready.filter((i) => i.kind === 'video' && !i.removedAt).length,
      retirados: ready.filter((i) => i.removedAt).length,
      naFila: processor.size,
      falhas: items.filter((i) => i.status === 'falhou').length,
      usadoBytes: store.usedBytes(),
      cotaBytes: config.quotaBytes,
      ...windowInfo(),
      ultimos: ready
        .slice(-15)
        .reverse()
        .map((i) => ({ n: i.n, tipo: i.kind, autor: i.author, origem: i.source, em: i.createdAt, retirado: i.removedAt !== null })),
    };
  }

  async function setRemoved(req: IncomingMessage, res: ServerResponse, removed: boolean) {
    requireInternal(req);
    const n = Number((await readJson(req)).n);
    const item = Number.isInteger(n) ? store.get(n) : null;
    if (!item || item.status !== 'pronta') throw new HttpError(404, 'nao_encontrada');
    const changed = removed !== (item.removedAt !== null);
    if (changed) store.update(n, { removedAt: removed ? now().toISOString() : null });
    send(req, res, 200, { ok: true, n, tipo: item.kind, autor: item.author, retirada: removed, mudou: changed });
  }

  function media(req: IncomingMessage, res: ServerResponse, name: string) {
    requireSession(req);
    const item = MEDIA_NAME.test(name) ? store.byFile(name) : null;
    if (!item || item.removedAt || item.status !== 'pronta') throw new HttpError(404, 'nao_encontrada');
    const file = path.join(dirs.media, name);
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      throw new HttpError(404, 'nao_encontrada');
    }
    const headers: Record<string, string> = {
      'Content-Type': MIME[path.extname(name)] ?? 'application/octet-stream',
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      start = Math.max(0, start);
      end = Math.min(end, size - 1);
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': String(size) });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://profeta');
    const p = url.pathname.replace(/\/+$/, '');
    const m = req.method === 'HEAD' ? 'GET' : req.method;
    if (!p.startsWith('/api/profeta')) throw new HttpError(404, 'nao_encontrada');
    const sub = p.slice('/api/profeta'.length) || '/';

    if (m === 'GET' && sub === '/saude') return send(req, res, 200, { ok: true });
    if (m === 'GET' && sub === '/sessao') return send(req, res, 200, { entrou: session(req) !== null, ...windowInfo() });
    if (m === 'POST' && sub === '/entrar') {
      requireSameSiteWrite(req);
      if (!loginLimit.take(clientIp(req))) throw new HttpError(429, 'devagar');
      const body = await readJson(req);
      if (!checkPassword(body.senha, config.password)) throw new HttpError(401, 'senha_errada');
      const { token } = createSession(config.sessionSecret, now().getTime());
      return send(req, res, 200, { ok: true, ...windowInfo() }, { 'Set-Cookie': sessionCookie(token) });
    }
    if (m === 'GET' && sub === '/edicao') {
      requireSession(req);
      const version = store.version;
      if (url.searchParams.get('v') === String(version)) return send(req, res, 200, { mudou: false, v: version });
      return send(req, res, 200, { mudou: true, v: version, ...windowInfo(), itens: store.publicItems() });
    }
    if (m === 'POST' && sub === '/enviar') return upload(req, res, url);
    if (m === 'GET' && sub.startsWith('/midia/')) return media(req, res, sub.slice('/midia/'.length));

    if (m === 'POST' && sub === '/interno/whatsapp') return fromWhatsApp(req, res);
    if (m === 'GET' && sub === '/interno/resumo') {
      requireInternal(req);
      return send(req, res, 200, summary());
    }
    if (m === 'POST' && sub === '/interno/retirar') return setRemoved(req, res, true);
    if (m === 'POST' && sub === '/interno/devolver') return setRemoved(req, res, false);
    throw new HttpError(404, 'nao_encontrada');
  }

  return async function handler(req: IncomingMessage, res: ServerResponse) {
    try {
      await route(req, res);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof HttpError) {
        // Recusado com o corpo ainda chegando (arquivo grande, sem sessão…): fecha a conexão ao responder.
        if (!req.readableEnded) res.setHeader('Connection', 'close');
        return send(req, res, error.status, { error: error.code });
      }
      log.error('profeta: erro inesperado:', error instanceof Error ? error.stack : error);
      send(req, res, 500, { error: 'indisponivel' });
    }
  };
}
