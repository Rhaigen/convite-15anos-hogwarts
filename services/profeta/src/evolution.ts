/**
 * Baixa da Evolution API a foto ou o vídeo que um convidado mandou à Aifos. O serviço roda na
 * mesma VPS e fala com ela pela rede interna do Docker, então a mídia não passa pelo Supabase.
 * Mesma chamada de supabase/functions/_shared/whatsapp/evolution.ts (downloadMedia).
 */
export interface EvolutionAccess {
  baseUrl: string;
  apiKey: string;
  instance: string;
}

export function createMediaDownloader(evo: EvolutionAccess, doFetch: typeof fetch = fetch) {
  return async (waMessageId: string): Promise<Buffer> => {
    const res = await doFetch(`${evo.baseUrl}/chat/getBase64FromMediaMessage/${encodeURIComponent(evo.instance)}`, {
      method: 'POST',
      headers: { apikey: evo.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { key: { id: waMessageId } }, convertToMp4: false }),
      signal: AbortSignal.timeout(90_000),
    });
    // Nunca registra o corpo: pode conter dados do contato.
    if (!res.ok) throw new Error(`Evolution respondeu HTTP ${res.status}`);
    const data = (await res.json().catch(() => null)) as { base64?: unknown } | null;
    if (typeof data?.base64 !== 'string' || data.base64.length === 0) throw new Error('Evolution respondeu sem mídia');
    return Buffer.from(data.base64, 'base64');
  };
}
