/** Parâmetros do agente. Os números de custo e limite ficam aqui, num lugar só. */

export type Effort = 'low' | 'medium' | 'high';

export interface AgentConfig {
  model: string;
  /** Profundidade do raciocínio (adaptativo). Ajustável pelo agent:eval. */
  effort: Effort;
  /** Teto por resposta, incluindo o raciocínio. */
  maxTokens: number;
  /** Chamadas ao modelo por mensagem do convidado (loop de ferramentas). */
  maxIterations: number;
  /** Sessão é encerrada (com resumo) depois deste silêncio... */
  sessionIdleMs: number;
  /** ...ou deste número de turnos do convidado. */
  sessionMaxTurns: number;
  /** Resumos de sessões anteriores entregues como memória. */
  summariesInContext: number;
  /** Retomada: silêncio mínimo do convidado antes de a Aifos retomar... */
  followUpAfterMs: number;
  /** ...e máximo (depois disso a conversa é dada como encerrada). */
  followUpWithinMs: number;
  /** Horário (São Paulo) em que a Aifos pode retomar: [início, fim). */
  followUpHours: [number, number];
}

export const DEFAULT_CONFIG: AgentConfig = {
  model: 'claude-haiku-5-5',
  effort: 'medium',
  maxTokens: 8000,
  maxIterations: 6,
  sessionIdleMs: 12 * 60 * 60 * 1000,
  sessionMaxTurns: 30,
  summariesInContext: 3,
  followUpAfterMs: 3 * 60 * 60 * 1000,
  followUpWithinMs: 24 * 60 * 60 * 1000,
  followUpHours: [9, 21],
};

/** Fuso usado no contexto (o mesmo de public.bot_today()). */
export const TIME_ZONE = 'America/Sao_Paulo';

/** Emojis que o agente pode usar como reação (ferramenta `reagir`). */
export const ALLOWED_REACTIONS = ['❤️', '🥰', '😂', '🙏', '✨', '🎉', '👏', '😮', '🐸', '⚡'] as const;

/** Reações disparadas pelo código, a partir do resultado real do banco. */
export const REACTION_ATTENDING = '❤️';
export const REACTION_DECLINED = '😢';
