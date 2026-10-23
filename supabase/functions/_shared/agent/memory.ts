/**
 * Memória em três camadas (todas por contato, nunca cruzando famílias):
 *  1. curto prazo: o histórico da sessão aberta vai inteiro ao modelo;
 *  2. resumos: ao encerrar uma sessão (silêncio longo ou muitos turnos), o modelo
 *     escreve um resumo curto, entregue nas sessões seguintes;
 *  3. notas duradouras: ferramenta `lembrar` (tools.ts).
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { GuestRepository, Memory, StoredMessage } from '../repo.ts';
import type { AgentConfig } from './config.ts';
import { SUMMARY_PROMPT } from './prompt.ts';

/** O mínimo do cliente da Anthropic que o agente usa (o falso dos testes implementa o mesmo). */
export interface MessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export type Logger = (event: string, data?: Record<string, unknown>) => void;

export function isSessionStale(session: NonNullable<Memory['session']>, now: Date, config: AgentConfig): boolean {
  const idle = now.getTime() - new Date(session.last_message_at).getTime();
  return idle >= config.sessionIdleMs || session.turns >= config.sessionMaxTurns;
}

const MAX_TRANSCRIPT = 30_000;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

/** Conversa legível para o resumo (sem o contexto do sistema nem o raciocínio). */
export function renderTranscript(messages: StoredMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const speaker = m.role === 'user' ? 'Convidado' : 'Aifos';
    if (typeof m.content === 'string') {
      lines.push(`${speaker}: ${m.content}`);
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as Record<string, unknown>[]) {
      if (b.type === 'text' && typeof b.text === 'string') lines.push(`${speaker}: ${b.text}`);
      else if (b.type === 'tool_use') lines.push(`(ação: ${String(b.name)} ${clip(JSON.stringify(b.input), 300)})`);
      else if (b.type === 'tool_result') lines.push(`(resultado: ${clip(String(b.content), 300)})`);
    }
  }
  const transcript = lines.join('\n');
  return transcript.length > MAX_TRANSCRIPT ? `…${transcript.slice(-MAX_TRANSCRIPT)}` : transcript;
}

export async function summarizeSession(
  client: MessagesClient,
  config: AgentConfig,
  messages: StoredMessage[],
): Promise<string | null> {
  const transcript = renderTranscript(messages);
  if (!transcript.trim()) return null;
  const response = await client.messages.create({
    model: config.model,
    max_tokens: 2000,
    output_config: { effort: 'low' },
    system: SUMMARY_PROMPT,
    messages: [{ role: 'user', content: `Conversa:\n${transcript}` }],
  });
  if (response.stop_reason === 'refusal') return null;
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  return text ? clip(text, 1500) : null;
}

/**
 * Encerra a sessão aberta se ela "esfriou" e devolve a memória atualizada.
 * Se o resumo falhar, a sessão é encerrada mesmo assim (sem resumo): a conversa
 * nova não pode ficar bloqueada por isso.
 */
export async function rotateIfStale(args: {
  repo: GuestRepository;
  client: MessagesClient;
  config: AgentConfig;
  phone: string;
  memory: Memory;
  now: Date;
  log: Logger;
}): Promise<Memory> {
  const { repo, client, config, phone, memory, now, log } = args;
  const session = memory.session;
  if (!session || !isSessionStale(session, now, config)) return memory;

  let summary: string | null = null;
  try {
    summary = await summarizeSession(client, config, session.messages);
  } catch (error) {
    log('summary_failed', { error: String(error) });
  }
  await repo.closeSession(session.id, summary);
  log('session_closed', { sessionId: session.id, turns: session.turns, summarized: summary !== null });
  return repo.loadMemory(phone, config.summariesInContext);
}
