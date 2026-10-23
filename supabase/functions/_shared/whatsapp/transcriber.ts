/**
 * Áudio do WhatsApp → texto. A API do Claude não recebe áudio, então a voz
 * passa antes por um serviço de transcrição, atrás desta interface.
 *
 * Implementação: OpenAI `gpt-4o-mini-transcribe` (mais preciso e mais barato que
 * o `whisper-1`, e aceita o OGG/Opus das mensagens de voz sem conversão).
 */

export interface Transcriber {
  /** Texto transcrito (vazio se não havia fala). */
  transcribe(audio: { base64: string; mimetype: string }): Promise<string>;
}

export interface OpenAiTranscriberConfig {
  apiKey: string;
  model?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Vocabulário da festa: ajuda a acertar nomes próprios e termos do tema. */
const VOCABULARY =
  'Conversa com a Professora Aifos sobre a festa de 15 anos da Sofia: confirmação de presença, Hogwarts, Grifinória, Rede de Flu, Casa de Pedra Slim.';

const EXTENSIONS: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'm4a',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
};

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64.replace(/^data:[^,]*,/, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function createOpenAiTranscriber(config: OpenAiTranscriberConfig): Transcriber {
  const doFetch = config.fetch ?? fetch;
  return {
    async transcribe({ base64, mimetype }) {
      const type = mimetype.split(';')[0]?.trim() || 'audio/ogg';
      const form = new FormData();
      form.append('file', new Blob([base64ToBytes(base64)], { type }), `audio.${EXTENSIONS[type] ?? 'ogg'}`);
      form.append('model', config.model ?? 'gpt-4o-mini-transcribe');
      form.append('language', 'pt');
      form.append('prompt', VOCABULARY);
      form.append('response_format', 'json');

      const response = await doFetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(config.timeoutMs ?? 45_000),
      });
      if (!response.ok) {
        throw new Error(`OpenAI transcrição: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
      }
      const data = (await response.json()) as { text?: unknown };
      return typeof data.text === 'string' ? data.text.trim() : '';
    },
  };
}
