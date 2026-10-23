/**
 * ffmpeg/ffprobe: foto → JPEG grande + miniatura WebP; vídeo → H.264 720p de até 15 s + pôster.
 * Tudo sem metadados (localização do GPS, aparelho). Um processo por vez e uma thread, para não
 * disputar a VPS com a Evolution (o canal da Aifos).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_VIDEO_SECONDS, type MediaKind } from './rules.ts';
import type { ItemFiles, Store } from './store.ts';

const FIT = (max: number) =>
  `scale='min(${max},iw)':'min(${max},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`;

export function photoArgs(input: string, grande: string, mini: string): string[][] {
  return [
    ['-y', '-v', 'error', '-threads', '1', '-i', input, '-map_metadata', '-1', '-frames:v', '1', '-vf', FIT(2560), '-q:v', '3', grande],
    ['-y', '-v', 'error', '-threads', '1', '-i', grande, '-map_metadata', '-1', '-frames:v', '1', '-vf', FIT(640), '-quality', '78', mini],
  ];
}

export function videoArgs(input: string, video: string, mini: string): string[][] {
  return [
    [
      '-y', '-v', 'error', '-threads', '1', '-i', input,
      '-t', String(MAX_VIDEO_SECONDS),
      '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1',
      '-vf', FIT(1280),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
      '-movflags', '+faststart', video,
    ],
    ['-y', '-v', 'error', '-threads', '1', '-ss', '0.5', '-i', video, '-frames:v', '1', '-vf', FIT(640), '-quality', '78', mini],
  ];
}

export const probeArgs = (file: string) => ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file];

/** Lê largura/altura da saída do ffprobe. */
export function parseProbe(json: string): { width: number; height: number } | null {
  try {
    const stream = (JSON.parse(json) as { streams?: { width?: unknown; height?: unknown }[] }).streams?.[0];
    const width = Number(stream?.width);
    const height = Number(stream?.height);
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  }
}

export type Runner = (cmd: 'ffmpeg' | 'ffprobe', args: string[]) => Promise<string>;

/** Roda ffmpeg/ffprobe com tempo-limite; devolve o stdout. */
export const runTool: Runner = (cmd, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} saiu com código ${code}: ${err.trim()}`));
    });
  });

export interface ProcessResult {
  files: ItemFiles;
  bytes: number;
  width: number | null;
  height: number | null;
}

/** Converte um bruto de tmp/ nos arquivos finais em midia/. Em erro, apaga o que tiver criado. */
export async function processFile(kind: MediaKind, rawPath: string, mediaDir: string, id: string, run: Runner = runTool): Promise<ProcessResult> {
  const files: ItemFiles =
    kind === 'foto' ? { mini: `${id}-m.webp`, grande: `${id}-g.jpg` } : { mini: `${id}-p.webp`, video: `${id}-v.mp4` };
  const full = (name: string) => path.join(mediaDir, name);
  try {
    const steps = kind === 'foto' ? photoArgs(rawPath, full(files.grande!), full(files.mini)) : videoArgs(rawPath, full(files.video!), full(files.mini));
    for (const args of steps) await run('ffmpeg', args);
    const main = full(files.grande ?? files.video!);
    const size = parseProbe(await run('ffprobe', probeArgs(main)));
    const bytes = Object.values(files).reduce((sum, name) => sum + fs.statSync(full(name)).size, 0);
    return { files, bytes, width: size?.width ?? null, height: size?.height ?? null };
  } catch (error) {
    for (const name of Object.values(files)) fs.rmSync(full(name), { force: true });
    throw error;
  }
}

/** Fila de um trabalho por vez: o bruto vira arquivos finais e o item passa a "pronta" (ou "falhou"). */
export function createProcessor(store: Store, dirs: { tmp: string; media: string }, run: Runner = runTool, log = console) {
  let busy = false;
  let pending: number[] = [];

  async function work(n: number) {
    const item = store.get(n);
    if (!item || item.status !== 'fila' || !item.rawFile) return;
    const rawPath = path.join(dirs.tmp, item.rawFile);
    try {
      const result = await processFile(item.kind, rawPath, dirs.media, item.id, run);
      store.update(n, { status: 'pronta', ...result, rawFile: null, rawBytes: 0 });
    } catch (error) {
      log.error(`profeta: falhou ao processar Nº ${n} (${item.kind}):`, error instanceof Error ? error.message : error);
      store.update(n, { status: 'falhou', rawFile: null, rawBytes: 0 });
    } finally {
      fs.rmSync(rawPath, { force: true });
    }
  }

  async function drain() {
    if (busy) return;
    busy = true;
    try {
      while (pending.length > 0) {
        const n = pending.shift()!;
        await work(n);
      }
    } finally {
      busy = false;
    }
  }

  return {
    enqueue(n: number) {
      if (!pending.includes(n)) pending.push(n);
      void drain();
    },
    /** Retoma o que ficou na fila antes de um reinício. */
    resume() {
      pending = [...pending, ...store.queued().map((i) => i.n).filter((n) => !pending.includes(n))];
      void drain();
    },
    get size() {
      return pending.length + (busy ? 1 : 0);
    },
  };
}

export type Processor = ReturnType<typeof createProcessor>;
