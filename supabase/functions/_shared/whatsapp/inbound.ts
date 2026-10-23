/**
 * Evento `messages.upsert` da Evolution API (v2.3) → mensagem do convidado.
 *
 * Formato (só o que usamos):
 *   { event: "messages.upsert", instance: "convite",
 *     data: { key: { id, fromMe, remoteJid, remoteJidAlt?, senderPn? },
 *             pushName, message: { conversation | extendedTextMessage | audioMessage | … },
 *             messageTimestamp } }
 *
 * Remetentes novos do WhatsApp chegam como "…@lid" (identificador anônimo); o
 * telefone vem em `remoteJidAlt` (ou `senderPn` em versões anteriores). Sem
 * telefone não há como saber quem é: a mensagem é ignorada.
 */
import type { InboundKind } from '../agent/context.ts';
import { phoneFromJid } from './phone.ts';

export interface ParsedMessage {
  waMessageId: string;
  phone: string;
  /** Conversa como o WhatsApp a identifica (para reagir e marcar como lida). */
  remoteJid: string;
  pushName: string | null;
  kind: InboundKind;
  /** Texto, legenda da imagem, ou null. */
  body: string | null;
  audioSeconds: number | null;
}

export type IgnoreReason =
  | 'not_message_event'
  | 'other_instance'
  | 'malformed'
  | 'from_me'
  | 'group_or_broadcast'
  | 'no_phone'
  | 'not_content'
  | 'too_old';

export type ParseResult = { ok: true; message: ParsedMessage } | { ok: false; reason: IgnoreReason };

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** Envelopes que só embrulham a mensagem de verdade. */
const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage'];

function unwrap(message: Obj): Obj {
  let current = message;
  for (let depth = 0; depth < 4; depth++) {
    const wrapper = WRAPPERS.find((w) => isObj(current[w]) && isObj((current[w] as Obj).message));
    if (!wrapper) return current;
    current = (current[wrapper] as Obj).message as Obj;
  }
  return current;
}

/** Eventos que não são conteúdo do convidado (edição, apagar, reação, enquete…). */
const NOT_CONTENT = [
  'protocolMessage',
  'reactionMessage',
  'editedMessage',
  'pollUpdateMessage',
  'senderKeyDistributionMessage',
  'keepInChatMessage',
  'pinInChatMessage',
];

function classify(message: Obj): { kind: InboundKind; body: string | null; audioSeconds: number | null } | null {
  if (NOT_CONTENT.some((k) => k in message)) return null;
  const text = str(message.conversation) ?? str((message.extendedTextMessage as Obj | undefined)?.text);
  if (text) return { kind: 'text', body: text, audioSeconds: null };
  if (isObj(message.audioMessage)) {
    const seconds = Number(message.audioMessage.seconds);
    return { kind: 'audio', body: null, audioSeconds: Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds) : null };
  }
  if (isObj(message.imageMessage)) return { kind: 'image', body: str(message.imageMessage.caption), audioSeconds: null };
  // Vídeo (inclusive o "GIF" do WhatsApp, que é um MP4): vai para O Profeta Diário quando o remetente está na lista.
  if (isObj(message.videoMessage)) return { kind: 'video', body: str(message.videoMessage.caption), audioSeconds: null };
  if (isObj(message.stickerMessage)) return { kind: 'sticker', body: null, audioSeconds: null };
  const keys = Object.keys(message).filter((k) => k !== 'messageContextInfo');
  return keys.length > 0 ? { kind: 'other', body: null, audioSeconds: null } : null;
}

export interface ParseOptions {
  instance: string;
  now?: Date;
  /** Mensagens mais antigas que isto são ignoradas (ressincronização do histórico). */
  maxAgeMs?: number;
}

export function parseUpsert(payload: unknown, options: ParseOptions): ParseResult {
  if (!isObj(payload)) return { ok: false, reason: 'malformed' };
  const event = str(payload.event)?.toLowerCase().replace(/_/g, '.');
  if (event !== 'messages.upsert') return { ok: false, reason: 'not_message_event' };
  if (payload.instance !== options.instance) return { ok: false, reason: 'other_instance' };

  const data = payload.data;
  if (!isObj(data) || !isObj(data.key) || !isObj(data.message)) return { ok: false, reason: 'malformed' };
  const key = data.key;
  const id = str(key.id);
  const remoteJid = str(key.remoteJid);
  if (!id || id.length > 128 || !remoteJid) return { ok: false, reason: 'malformed' };
  if (key.fromMe === true) return { ok: false, reason: 'from_me' };

  const server = remoteJid.split('@')[1] ?? '';
  if (server !== 's.whatsapp.net' && server !== 'c.us' && server !== 'lid') return { ok: false, reason: 'group_or_broadcast' };

  const phone = phoneFromJid(remoteJid) ?? phoneFromJid(str(key.remoteJidAlt)) ?? phoneFromJid(str(key.senderPn));
  if (!phone) return { ok: false, reason: 'no_phone' };

  const timestamp = Number(data.messageTimestamp);
  if (Number.isFinite(timestamp) && timestamp > 0) {
    const now = (options.now ?? new Date()).getTime();
    if (now - timestamp * 1000 > (options.maxAgeMs ?? 10 * 60_000)) return { ok: false, reason: 'too_old' };
  }

  const content = classify(unwrap(data.message));
  if (!content) return { ok: false, reason: 'not_content' };

  return {
    ok: true,
    message: {
      waMessageId: id,
      phone,
      remoteJid,
      pushName: str(data.pushName)?.slice(0, 80) ?? null,
      ...content,
      body: content.body?.slice(0, 4000) ?? null,
    },
  };
}
