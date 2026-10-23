/**
 * Regras puras do Profeta Diário: tipo do arquivo pela assinatura (nunca pela extensão),
 * limites de tamanho, cota, janela de envio e textos que vêm de fora (autor, legenda).
 */

export type MediaKind = 'foto' | 'video';

export interface Sniffed {
  kind: MediaKind;
  mime: string;
}

/** Bruto recebido (antes do ffmpeg). A foto já chega reduzida pelo site; a margem cobre quem não conseguiu reduzir. */
export const MAX_RAW_BYTES: Record<MediaKind, number> = {
  foto: 20 * 1024 * 1024,
  video: 80 * 1024 * 1024,
};

/** Duração máxima guardada de um vídeo (o resto é cortado). */
export const MAX_VIDEO_SECONDS = 15;

const ascii = (buf: Uint8Array, start: number, end: number) => String.fromCharCode(...buf.subarray(start, end));

/**
 * Reconhece JPEG, PNG, WebP, HEIC/HEIF (fotos) e MP4/MOV/3GP (vídeos) pelos primeiros bytes.
 * Qualquer outra coisa (inclusive um vídeo disfarçado de .jpg) é recusada.
 */
export function sniffMedia(head: Uint8Array): Sniffed | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: 'foto', mime: 'image/jpeg' };
  if (head.length >= 8 && ascii(head, 1, 4) === 'PNG' && head[0] === 0x89) return { kind: 'foto', mime: 'image/png' };
  if (head.length >= 12 && ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') return { kind: 'foto', mime: 'image/webp' };
  if (head.length >= 12 && ascii(head, 4, 8) === 'ftyp') {
    const brand = ascii(head, 8, 12);
    if (/^(heic|heix|heim|heis|hevc|hevx|mif1|msf1|avif)$/.test(brand)) return { kind: 'foto', mime: 'image/heic' };
    if (brand === 'qt  ') return { kind: 'video', mime: 'video/quicktime' };
    if (/^3g/.test(brand)) return { kind: 'video', mime: 'video/3gpp' };
    if (/^(isom|iso[2-9]|mp41|mp42|avc1|M4V |MSNV|dash|mmp4|f4v )$/.test(brand)) return { kind: 'video', mime: 'video/mp4' };
  }
  return null;
}

export type WindowState = 'antes' | 'aberta' | 'fechada';

export function uploadWindow(now: Date, opensAt: Date, closesAt: Date): WindowState {
  if (now < opensAt) return 'antes';
  return now < closesAt ? 'aberta' : 'fechada';
}

export interface QuotaCheck {
  usedBytes: number;
  quotaBytes: number;
  /** Espaço livre real no disco (statfs); null se não deu para ler. */
  freeBytes: number | null;
  reserveBytes: number;
}

/** Cabe mais um arquivo de até `incoming` bytes? Conta a cota do Profeta e o disco de verdade. */
export function hasRoom(check: QuotaCheck, incoming: number): boolean {
  if (check.usedBytes + incoming > check.quotaBytes) return false;
  if (check.freeBytes !== null && check.freeBytes - incoming < check.reserveBytes) return false;
  return true;
}

/**
 * Texto curto vindo de fora (nome de quem tirou, legenda): sem controles, espaços colapsados,
 * cortado no limite. Vazio vira null.
 */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const text = value.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return [...text].slice(0, max).join('').trim();
}
