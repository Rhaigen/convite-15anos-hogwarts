/**
 * Cliente da Evolution API (v2.3): só as chamadas que a Aifos usa.
 * `fetch` é injetável (testes usam um servidor falso em memória).
 */

export interface WhatsAppClient {
  /** Envia um texto. `typingMs` mostra "digitando…" antes do envio. */
  sendText(phone: string, text: string, typingMs?: number): Promise<void>;
  /** Reage a uma mensagem recebida. */
  sendReaction(remoteJid: string, waMessageId: string, emoji: string): Promise<void>;
  /** Marca mensagens recebidas como lidas (os dois tiques azuis). */
  markRead(remoteJid: string, waMessageIds: string[]): Promise<void>;
  /** Baixa a mídia de uma mensagem recebida (áudio). */
  downloadMedia(waMessageId: string): Promise<{ base64: string; mimetype: string }>;
}

export interface EvolutionConfig {
  baseUrl: string;
  apiKey: string;
  instance: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class EvolutionError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    detail: string,
  ) {
    super(`Evolution ${path}: HTTP ${status} ${detail}`.trim());
    this.name = 'EvolutionError';
  }
}

export function createEvolutionClient(config: EvolutionConfig): WhatsAppClient {
  const doFetch = config.fetch ?? fetch;
  const base = config.baseUrl.replace(/\/+$/, '');
  const instance = encodeURIComponent(config.instance);
  const timeoutMs = config.timeoutMs ?? 30_000;

  async function post(path: string, body: unknown, extraMs = 0): Promise<unknown> {
    const response = await doFetch(`${base}${path}/${instance}`, {
      method: 'POST',
      headers: { apikey: config.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs + extraMs),
    });
    const text = await response.text();
    // Nunca devolve o corpo inteiro no erro: pode conter dados do contato.
    if (!response.ok) throw new EvolutionError(path, response.status, text.slice(0, 200));
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  return {
    async sendText(phone, text, typingMs = 0) {
      const delay = Math.max(0, Math.round(typingMs));
      await post('/message/sendText', { number: phone, text, delay, linkPreview: false }, delay);
    },
    async sendReaction(remoteJid, waMessageId, emoji) {
      await post('/message/sendReaction', { key: { remoteJid, fromMe: false, id: waMessageId }, reaction: emoji });
    },
    async markRead(remoteJid, waMessageIds) {
      if (waMessageIds.length === 0) return;
      await post('/chat/markMessageAsRead', {
        readMessages: waMessageIds.map((id) => ({ remoteJid, fromMe: false, id })),
      });
    },
    async downloadMedia(waMessageId) {
      const data = (await post('/chat/getBase64FromMediaMessage', {
        message: { key: { id: waMessageId } },
        convertToMp4: false,
      })) as { base64?: unknown; mimetype?: unknown } | null;
      if (typeof data?.base64 !== 'string' || data.base64.length === 0) {
        throw new EvolutionError('/chat/getBase64FromMediaMessage', 200, 'sem mídia na resposta');
      }
      return { base64: data.base64, mimetype: typeof data.mimetype === 'string' ? data.mimetype : 'audio/ogg' };
    },
  };
}

/**
 * Falha passageira, em que a mensagem com certeza não saiu: vale tentar de novo.
 * A Evolution responde 400 "Connection Closed" enquanto reconecta ao WhatsApp
 * (teste real, 2026-10-15). Timeout não entra: o envio pode ter saído e
 * repetir duplicaria a mensagem.
 */
export function isTransientSendError(error: unknown): boolean {
  if (error instanceof EvolutionError) {
    return error.status >= 500 || error.status === 429 || /connection closed/i.test(error.message);
  }
  // fetch sem resposta nenhuma (conexão recusada, DNS): TypeError no Deno e no Node.
  return error instanceof TypeError;
}

/** Tempo de "digitando…" proporcional ao texto, como uma pessoa (com teto). */
export function typingDelayMs(text: string): number {
  return Math.min(5_000, Math.max(1_200, 600 + text.length * 30));
}
