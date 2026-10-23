/**
 * O Profeta Diário (fotos e vídeos dos convidados, guardados na VPS): o que a Aifos faz com ele,
 * sempre por código, sem IA.
 *
 * - Foto ou vídeo de convidado identificado vai direto para o jornal: a Edge Function só passa o
 *   id da mensagem; o serviço da VPS baixa a mídia da Evolution pela rede interna.
 * - Comandos dos organizadores: "fotos", "retirar foto N", "devolver foto N".
 *
 * Rotas internas do serviço (services/profeta/src/server.ts), protegidas pelo cabeçalho
 * x-profeta-secret. Erro de rede vira { ok: false, error: 'indisponivel' }: nunca sucesso falso.
 */

export interface ProfetaConfig {
  /** Ex.: https://convite.example.com/api/profeta (o Traefik leva ao serviço). */
  apiUrl: string;
  secret: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export type ProfetaSendResult =
  | { ok: true; n: number; tipo: 'foto' | 'video'; repetida?: boolean }
  | { ok: false; error: string };

export interface ProfetaSummary {
  total: number;
  fotos: number;
  videos: number;
  retirados: number;
  naFila: number;
  falhas: number;
  usadoBytes: number;
  cotaBytes: number;
  janela: 'antes' | 'aberta' | 'fechada';
  ultimos: { n: number; tipo: 'foto' | 'video'; autor: string | null; origem: 'site' | 'whatsapp'; em: string; retirado: boolean }[];
}

export type ProfetaRemoval =
  | { ok: true; n: number; tipo: 'foto' | 'video'; autor: string | null; retirada: boolean; mudou: boolean }
  | { ok: false; error: string };

export interface ProfetaClient {
  sendFromWhatsApp(input: { waMessageId: string; author: string; caption: string | null }): Promise<ProfetaSendResult>;
  summary(): Promise<ProfetaSummary>;
  setRemoved(n: number, removed: boolean): Promise<ProfetaRemoval>;
}

export function createProfetaClient(config: ProfetaConfig): ProfetaClient {
  const doFetch = config.fetch ?? fetch;
  const base = config.apiUrl.replace(/\/+$/, '');
  // O serviço baixa a mídia da Evolution antes de responder (rede interna da VPS, segundos).
  const timeoutMs = config.timeoutMs ?? 60_000;

  async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
    const res = await doFetch(`${base}/interno/${path}`, {
      method,
      headers: { 'x-profeta-secret': config.secret, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, data };
  }

  const errorOf = (data: Record<string, unknown>) => (typeof data.error === 'string' ? data.error : 'indisponivel');

  return {
    async sendFromWhatsApp({ waMessageId, author, caption }) {
      try {
        const { status, data } = await call('POST', 'whatsapp', { waMessageId, autor: author, legenda: caption });
        if ((status === 200 || status === 202) && typeof data.n === 'number') {
          return { ok: true, n: data.n, tipo: data.tipo === 'video' ? 'video' : 'foto', repetida: data.repetida === true };
        }
        return { ok: false, error: errorOf(data) };
      } catch {
        return { ok: false, error: 'indisponivel' };
      }
    },
    async summary() {
      const { status, data } = await call('GET', 'resumo');
      if (status !== 200) throw new Error(`Profeta respondeu HTTP ${status}`);
      return data as unknown as ProfetaSummary;
    },
    async setRemoved(n, removed) {
      try {
        const { status, data } = await call('POST', removed ? 'retirar' : 'devolver', { n });
        if (status === 200) return data as unknown as ProfetaRemoval;
        return { ok: false, error: errorOf(data) };
      } catch {
        return { ok: false, error: 'indisponivel' };
      }
    },
  };
}

/** Respostas fixas da Aifos (personagem, sem IA) para quem manda foto ou vídeo. */
export const PROFETA_REPLIES = {
  sent: (count: number, videos: number, url: string | null) => {
    const what = count === 1 ? (videos === 1 ? 'Seu vídeo foi capturado' : 'Sua fotografia foi capturada') : `${count} lembranças capturadas`;
    return `_Clique!_ 📸 ${what} e já ${count === 1 ? 'voa' : 'voam'} para *O Profeta Diário*, o jornal das fotografias da festa!${
      url ? `\n\nEm instantes ${count === 1 ? 'aparece' : 'aparecem'} lá para todos os convidados: ${url}` : ''
    }`;
  },
  before:
    '_guarda a fotografia com cuidado no bolso da capa_ ✨ *O Profeta Diário* só começa a circular no dia da festa! Guarde suas fotos e mande para mim a partir do dia 20/02, combinado?',
  closed:
    'As rotativas do *Profeta Diário* já pararam: o envio de fotografias foi encerrado. 🦉 Obrigada por cada lembrança!',
  failed: (url: string | null) =>
    `Ops, a coruja não conseguiu levar essa ao *Profeta Diário* agora. 🦉${url ? ` Tente pela página do jornal: ${url}` : ' Tente de novo daqui a pouco, por favor.'}`,
} as const;

/** "fotos", "/Fotos", "foto" → resumo do Profeta (comando do organizador). */
export function isPhotosCommand(normalized: string): boolean {
  return /^\/?fotos?$/.test(normalized);
}

/** "retirar foto 7", "Retirar o vídeo #7", "devolver foto 7." → some ou volta ao jornal. */
export function parsePhotoCommand(text: string | null): { removed: boolean; n: number } | null {
  const normalized = (text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
  const match = /^\/?(retirar|devolver)\s+(?:a\s+|o\s+)?(?:foto|fotografia|video)\s*(?:n[ºo°.]?\s*)?#?\s*(\d{1,9})\s*[.!]*$/.exec(normalized);
  return match ? { removed: match[1] === 'retirar', n: Number(match[2]) } : null;
}
