/**
 * O Profeta Diário (/profeta/): conversa com o serviço da VPS, no mesmo domínio do convite
 * (/api/profeta). Sem chave nenhuma: a porta é a palavra mágica, que vira um cookie httpOnly.
 * É o único lugar do site que envia arquivos; os POSTs levam o cabeçalho x-profeta (outro site
 * não consegue mandá-lo).
 */
import { profetaConfig } from '../content/profeta';

export type WindowState = 'antes' | 'aberta' | 'fechada';

export interface ProfetaItem {
  n: number;
  tipo: 'foto' | 'video';
  autor: string | null;
  legenda: string | null;
  w: number | null;
  h: number | null;
  mini: string;
  grande: string | null;
  video: string | null;
  em: string;
}

export interface Edition {
  v: number;
  janela: WindowState;
  itens: ProfetaItem[];
}

export interface SessionInfo {
  entrou: boolean;
  janela: WindowState;
}

/** Teto de itens aceitos de uma resposta (o serviço também limita pela cota). */
export const MAX_ITEMS = 5000;

const WINDOWS: WindowState[] = ['antes', 'aberta', 'fechada'];
const MEDIA = /^\/api\/profeta\/midia\/[a-f0-9]{20}-[a-z]\.(jpg|webp|mp4)$/;
const asWindow = (v: unknown): WindowState => (WINDOWS.includes(v as WindowState) ? (v as WindowState) : 'fechada');
const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);
const media = (v: unknown) => (typeof v === 'string' && MEDIA.test(v) ? v : null);
const size = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 20_000 ? v : null);

/** Valida a edição; descarta itens fora do formato (endereços só de /api/profeta/midia). `null` = inválida. */
export function parseEdition(raw: unknown): Edition | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as { v?: unknown; janela?: unknown; itens?: unknown };
  if (typeof data.v !== 'number' || !Array.isArray(data.itens)) return null;
  const seen = new Set<number>();
  const itens: ProfetaItem[] = [];
  for (const entry of data.itens) {
    const i = (entry ?? {}) as Record<string, unknown>;
    const n = typeof i.n === 'number' && Number.isInteger(i.n) && i.n > 0 ? i.n : null;
    const tipo = i.tipo === 'foto' || i.tipo === 'video' ? i.tipo : null;
    const mini = media(i.mini);
    const grande = media(i.grande);
    const video = media(i.video);
    if (!n || !tipo || !mini || seen.has(n)) continue;
    if (tipo === 'foto' ? !grande : !video) continue;
    seen.add(n);
    itens.push({
      n,
      tipo,
      autor: text(i.autor, 80),
      legenda: text(i.legenda, 200),
      w: size(i.w),
      h: size(i.h),
      mini,
      grande,
      video,
      em: typeof i.em === 'string' ? i.em : '',
    });
    if (itens.length >= MAX_ITEMS) break;
  }
  itens.sort((a, b) => b.n - a.n);
  return { v: data.v, janela: asWindow(data.janela), itens };
}

export class ProfetaError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

async function readError(res: Response): Promise<ProfetaError> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return new ProfetaError(typeof body?.error === 'string' ? body.error : 'desconhecido', res.status);
}

const get = (path: string, signal?: AbortSignal) =>
  fetch(`${profetaConfig.api}${path}`, { credentials: 'same-origin', signal, headers: { Accept: 'application/json' } });

export async function fetchSession(signal?: AbortSignal): Promise<SessionInfo> {
  const res = await get('/sessao', signal);
  if (!res.ok) throw await readError(res);
  const data = (await res.json()) as { entrou?: unknown; janela?: unknown };
  return { entrou: data.entrou === true, janela: asWindow(data.janela) };
}

export async function login(password: string): Promise<SessionInfo> {
  const res = await fetch(`${profetaConfig.api}/entrar`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'x-profeta': '1' },
    body: JSON.stringify({ senha: password }),
  });
  if (!res.ok) throw await readError(res);
  const data = (await res.json()) as { janela?: unknown };
  return { entrou: true, janela: asWindow(data.janela) };
}

/** Edição atual; `null` se não mudou desde a versão `v`. */
export async function fetchEdition(v: number | null, signal?: AbortSignal): Promise<Edition | null> {
  const res = await get(`/edicao${v === null ? '' : `?v=${v}`}`, signal);
  if (!res.ok) throw await readError(res);
  const raw = (await res.json()) as { mudou?: unknown };
  if (raw.mudou === false) return null;
  const edition = parseEdition(raw);
  if (!edition) throw new ProfetaError('desconhecido', 200);
  return edition;
}

export interface UploadMeta {
  tipo: 'foto' | 'video';
  autor: string;
  legenda: string;
}

/** Endereço do envio, com os textos opcionais na query (o corpo é o arquivo). */
export function uploadUrl(meta: UploadMeta): string {
  const q = new URLSearchParams({ tipo: meta.tipo });
  if (meta.autor.trim()) q.set('autor', meta.autor.trim().slice(0, 60));
  if (meta.legenda.trim()) q.set('legenda', meta.legenda.trim().slice(0, 140));
  return `${profetaConfig.api}/enviar?${q}`;
}

type UploadReply = { n?: unknown; error?: unknown };

/**
 * Envia um arquivo (XHR, para mostrar o progresso). Resolve com o número no jornal; rejeita com
 * ProfetaError (`rede` quando a conexão cai).
 */
export function uploadFile(body: Blob, meta: UploadMeta, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', uploadUrl(meta));
    xhr.withCredentials = true;
    xhr.setRequestHeader('x-profeta', '1');
    xhr.setRequestHeader('Content-Type', body.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new ProfetaError('rede', 0));
    xhr.ontimeout = () => reject(new ProfetaError('rede', 0));
    xhr.onabort = () => reject(new ProfetaError('cancelado', 0));
    xhr.onload = () => {
      let data: UploadReply | null = null;
      try {
        data = JSON.parse(xhr.responseText) as UploadReply;
      } catch {
        /* resposta sem JSON (proxy): cai no erro genérico */
      }
      if (xhr.status === 202 && typeof data?.n === 'number') resolve(data.n);
      else reject(new ProfetaError(typeof data?.error === 'string' ? data.error : xhr.status >= 500 ? 'rede' : 'desconhecido', xhr.status));
    };
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(body);
  });
}

/** Vale tentar de novo? Internet caída, servidor ocupado ou limite de ritmo. Recusas definitivas, não. */
export function isRetryable(error: unknown): boolean {
  return error instanceof ProfetaError && (error.code === 'rede' || error.code === 'devagar' || error.status >= 500 && error.status !== 507);
}

/** Espera antes da tentativa `attempt` (1, 2, 3…): 2 s, 5 s, 12 s, 30 s. */
export function retryDelayMs(attempt: number): number {
  return [2000, 5000, 12_000, 30_000][Math.min(attempt, 4) - 1] ?? 30_000;
}

/** Maior lado em `max`, mantendo a proporção (nunca aumenta). */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export function kindOf(file: File): 'foto' | 'video' | null {
  if (file.type.startsWith('image/')) return 'foto';
  if (file.type.startsWith('video/')) return 'video';
  // Alguns Androids mandam o tipo vazio: decide pela extensão (o serviço confere a assinatura).
  if (/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) return 'foto';
  if (/\.(mp4|mov|3gp|m4v)$/i.test(file.name)) return 'video';
  return null;
}

/**
 * Reduz a foto no próprio celular (até 2560 px, JPEG), girando conforme a câmera e sem os dados
 * de localização. Se o navegador não conseguir abrir (ex.: HEIC num Android), manda o original.
 */
export async function preparePhoto(file: File): Promise<Blob> {
  const { photoMaxPx, photoQuality, photoKeepBytes } = profetaConfig;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const target = fitWithin(bitmap.width, bitmap.height, photoMaxPx);
    const small = target.width === bitmap.width && target.height === bitmap.height;
    if (small && file.type === 'image/jpeg' && file.size <= photoKeepBytes) {
      bitmap.close();
      return file;
    }
    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, target.width, target.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', photoQuality));
    canvas.width = canvas.height = 0;
    return blob ?? file;
  } catch {
    return file;
  }
}

/** Duração do vídeo em segundos (null se o navegador não souber ler). */
export function videoDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    const done = (value: number | null) => {
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      resolve(value);
    };
    video.preload = 'metadata';
    video.muted = true;
    video.onloadedmetadata = () => done(Number.isFinite(video.duration) ? video.duration : null);
    video.onerror = () => done(null);
    window.setTimeout(() => done(null), 8000);
    video.src = url;
  });
}

const NAME_KEY = 'profeta:autor';

export function loadAuthor(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveAuthor(name: string): void {
  try {
    if (name.trim()) localStorage.setItem(NAME_KEY, name.trim().slice(0, 60));
    else localStorage.removeItem(NAME_KEY);
  } catch {
    /* navegação privada: só não lembra */
  }
}

/** `?profeta=demo` da demonstração; sempre null fora do `npm run dev`. */
export function profetaDemoParam(search = typeof location === 'undefined' ? '' : location.search): string | null {
  return import.meta.env.DEV ? new URLSearchParams(search).get('profeta') : null;
}

/**
 * Só no `npm run dev`: edição FICTÍCIA de scripts/fixtures/profeta-demo.json (fotos da galeria do
 * convite), sem servidor. `demo` = jornal aberto; `antes`/`fechada` mudam a janela; `vazio`. Fora
 * do dev, o build remove este caminho.
 */
export async function demoEdition(param: string): Promise<Edition> {
  const { itens } = (await import('../../scripts/fixtures/profeta-demo.json')).default;
  const janela: WindowState = param === 'antes' ? 'antes' : param === 'fechada' ? 'fechada' : 'aberta';
  return { v: 1, janela, itens: param === 'vazio' ? [] : (itens as ProfetaItem[]) };
}
