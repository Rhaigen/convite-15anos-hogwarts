/**
 * Cartas do Salão Principal: leitura (só GET, sem chave) da função pública
 * site-messages. O site nunca escreve nada; os recados chegam pela Professora Aifos
 * e só aparecem depois que os organizadores aprovam. Antes da festa a função nem
 * envia o texto (selo aplicado no banco); aqui, por garantia, selado = sem texto.
 */
import { messageWallConfig } from '../content/settings';

export interface WallLetter {
  id: string;
  from: string;
  /** Só depois que os selos se rompem. */
  body?: string;
}

export interface Wall {
  sealed: boolean;
  /** Quando os selos se rompem (null se a função não informou). */
  unsealAt: Date | null;
  letters: WallLetter[];
}

/** Teto de cartas exibidas (a função também limita). */
export const MAX_LETTERS = 300;
const TIMEOUT_MS = 8000;

const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/** Valida a resposta da função; descarta itens fora do formato e ids repetidos. `null` = resposta inválida. */
export function parseWall(raw: unknown): Wall | null {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { letters?: unknown }).letters)) return null;
  const data = raw as { sealed?: unknown; unsealAt?: unknown; letters: unknown[] };
  const sealed = data.sealed !== false;
  const unsealAt = typeof data.unsealAt === 'string' && !Number.isNaN(Date.parse(data.unsealAt)) ? new Date(data.unsealAt) : null;
  const seen = new Set<string>();
  const letters: WallLetter[] = [];
  for (const item of data.letters) {
    const l = (item ?? {}) as Record<string, unknown>;
    if (!isText(l.id, 64) || !isText(l.from, 120) || seen.has(l.id)) continue;
    if (!sealed && !isText(l.body, 1000)) continue;
    seen.add(l.id);
    letters.push(sealed ? { id: l.id, from: l.from.trim() } : { id: l.id, from: l.from.trim(), body: l.body as string });
    if (letters.length >= MAX_LETTERS) break;
  }
  return { sealed, unsealAt, letters };
}

/** Endereço das cartas: VITE_MESSAGES_URL ou `messageWallConfig.endpoint`. */
export function wallEndpoint(): string | null {
  return import.meta.env.VITE_MESSAGES_URL || messageWallConfig.endpoint;
}

/** `?salao=…` da demonstração; sempre null fora do `npm run dev`. */
export function wallDemoParam(search = typeof location === 'undefined' ? '' : location.search): string | null {
  return import.meta.env.DEV ? new URLSearchParams(search).get('salao') : null;
}

/**
 * "selado-80", "Aberto 80", "selado–80" (o teclado do celular troca o hífen por travessão), "vazio".
 * Estado desconhecido = selado; sem número = só as cartas do arquivo.
 */
export function parseDemoParam(param: string): { state: 'selado' | 'aberto' | 'vazio'; amount: number | null } {
  const text = param.trim().toLowerCase();
  const state = text.startsWith('aberto') ? 'aberto' : text.startsWith('vazio') ? 'vazio' : 'selado';
  const digits = /(\d+)\s*$/.exec(text);
  return { state, amount: digits ? Number(digits[1]) : null };
}

/**
 * Só no `npm run dev`: cartas FICTÍCIAS de scripts/fixtures/salao-demo.json, sem banco nem servidor.
 * `selado` | `aberto` | `vazio`; com quantidade, `selado-80` (repete as cartas). Fora do dev, o build
 * remove este caminho (import.meta.env.DEV vira false) e o arquivo nem é publicado.
 */
export async function demoWall(param: string): Promise<Wall> {
  const { letters } = (await import('../../scripts/fixtures/salao-demo.json')).default;
  const { state, amount } = parseDemoParam(param);
  const sealed = state !== 'aberto';
  const count = state === 'vazio' ? 0 : Math.min(MAX_LETTERS, amount ?? letters.length);
  const list = Array.from({ length: count }, (_, i) => {
    const l = letters[i % letters.length]!;
    return { ...l, id: `${l.id}-${i}` };
  });
  return parseWall({ sealed, unsealAt: '2027-02-20T03:00:00+00:00', letters: list })!;
}

/** Busca as cartas (com tempo-limite). Lança erro se a função falhar ou responder fora do formato. */
export async function fetchWall(url: string, signal?: AbortSignal): Promise<Wall> {
  const timeout = new AbortController();
  const timer = window.setTimeout(() => timeout.abort(), TIMEOUT_MS);
  const onAbort = () => timeout.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(url, { method: 'GET', credentials: 'omit', signal: timeout.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const wall = parseWall(await res.json());
    if (!wall) throw new Error('resposta inválida');
    return wall;
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

const READ_KEY = 'salao:lidas';

/** Cartas já lidas neste navegador (selo partido). Sem armazenamento, começa vazio. */
export function loadReadLetters(): Set<string> {
  try {
    const raw = localStorage.getItem(READ_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveReadLetters(ids: Set<string>): void {
  try {
    localStorage.setItem(READ_KEY, JSON.stringify([...ids].slice(-MAX_LETTERS)));
  } catch {
    /* navegação privada ou armazenamento bloqueado: só não lembra */
  }
}
