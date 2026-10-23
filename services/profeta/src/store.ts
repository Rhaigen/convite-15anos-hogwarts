/**
 * A edição do Profeta: lista de fotos e vídeos guardada em `edicao.json` no disco de tamanho fixo.
 * Poucos milhares de itens cabem folgados em memória; cada mudança regrava o arquivo de forma
 * atômica (arquivo temporário + rename), então uma queda nunca deixa a lista pela metade.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MediaKind } from './rules.ts';

export type ItemStatus = 'fila' | 'pronta' | 'falhou';
export type ItemSource = 'site' | 'whatsapp';

export interface ItemFiles {
  /** Miniatura WebP (~640 px): foto ou pôster do vídeo. */
  mini: string;
  /** Foto grande (JPEG ~2560 px). */
  grande?: string;
  /** Vídeo H.264 720p, até 15 s. */
  video?: string;
}

export interface Item {
  /** Número público, sequencial: "Nº 37" no jornal e no "retirar foto 37". */
  n: number;
  /** Prefixo aleatório dos arquivos (os endereços não são adivinháveis). */
  id: string;
  kind: MediaKind;
  source: ItemSource;
  author: string | null;
  caption: string | null;
  createdAt: string;
  status: ItemStatus;
  removedAt: string | null;
  waMessageId: string | null;
  /** Arquivo bruto em tmp/ enquanto espera o ffmpeg. */
  rawFile: string | null;
  rawBytes: number;
  /** Bytes guardados depois do processamento. */
  bytes: number;
  width: number | null;
  height: number | null;
  files: ItemFiles | null;
}

interface Saved {
  version: number;
  nextN: number;
  items: Item[];
}

export interface PublicItem {
  n: number;
  tipo: MediaKind;
  autor: string | null;
  legenda: string | null;
  w: number | null;
  h: number | null;
  mini: string;
  grande: string | null;
  video: string | null;
  em: string;
}

export const MEDIA_PATH = '/api/profeta/midia/';

export function toPublic(item: Item): PublicItem | null {
  if (item.status !== 'pronta' || item.removedAt || !item.files) return null;
  return {
    n: item.n,
    tipo: item.kind,
    autor: item.author,
    legenda: item.caption,
    w: item.width,
    h: item.height,
    mini: MEDIA_PATH + item.files.mini,
    grande: item.files.grande ? MEDIA_PATH + item.files.grande : null,
    video: item.files.video ? MEDIA_PATH + item.files.video : null,
    em: item.createdAt,
  };
}

export type NewItem = Pick<Item, 'kind' | 'source' | 'author' | 'caption' | 'waMessageId' | 'rawFile' | 'rawBytes'>;

export function createStore(dataDir: string, now: () => Date = () => new Date()) {
  const file = path.join(dataDir, 'edicao.json');
  let state: Saved = { version: 0, nextN: 1, items: [] };
  if (fs.existsSync(file)) {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8')) as Saved;
    if (!Array.isArray(loaded.items) || !Number.isInteger(loaded.nextN)) throw new Error(`${file} fora do formato`);
    state = loaded;
  }
  const byFile = new Map<string, Item>();
  const reindex = (item: Item) => {
    for (const name of Object.values(item.files ?? {})) if (name) byFile.set(name, item);
  };
  state.items.forEach(reindex);

  function save() {
    state.version += 1;
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
  }

  const find = (n: number) => state.items.find((i) => i.n === n) ?? null;

  return {
    get version() {
      return state.version;
    },
    add(input: NewItem): Item {
      const item: Item = {
        ...input,
        n: state.nextN,
        id: randomBytes(10).toString('hex'),
        createdAt: now().toISOString(),
        status: 'fila',
        removedAt: null,
        bytes: 0,
        width: null,
        height: null,
        files: null,
      };
      state.nextN += 1;
      state.items.push(item);
      save();
      return item;
    },
    update(n: number, patch: Partial<Omit<Item, 'n' | 'id'>>): Item | null {
      const item = find(n);
      if (!item) return null;
      Object.assign(item, patch);
      reindex(item);
      save();
      return item;
    },
    get: find,
    byWaMessageId: (id: string) => state.items.find((i) => i.waMessageId === id) ?? null,
    byFile: (name: string) => byFile.get(name) ?? null,
    queued: () => state.items.filter((i) => i.status === 'fila'),
    /** Publicadas e não retiradas, da mais nova para a mais antiga. */
    publicItems: () =>
      state.items
        .map(toPublic)
        .filter((p): p is PublicItem => p !== null)
        .reverse(),
    /** Tudo que ocupa disco: guardados (inclusive retirados, que podem voltar) + brutos na fila. */
    usedBytes: () => state.items.reduce((sum, i) => sum + i.bytes + (i.status === 'fila' ? i.rawBytes : 0), 0),
    all: () => state.items,
  };
}

export type Store = ReturnType<typeof createStore>;
