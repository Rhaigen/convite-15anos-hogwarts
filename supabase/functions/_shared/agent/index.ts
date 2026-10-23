/**
 * Professora Aifos: um turno de conversa.
 *
 *   mensagens recebidas ──► teto de uso ──► memória (rotação + resumo)
 *     ──► [histórico, mensagem do convidado, contexto verificado (system)]
 *     ──► loop de ferramentas (Haiku) ──► histórico gravado (só acréscimo)
 *     ──► respostas, reação e avisos à família (executados por quem chamou)
 *
 * Retomada (`followUp`): quando a conversa parou com a Aifos esperando a
 * pessoa, ela escreve uma vez depois de um tempo, se o agente achar que ficou
 * algo pendente. Quem chama (cron da fase 3) escolhe os candidatos com
 * `followUpCandidates` e respeita o horário com `canFollowUpNow`.
 *
 * TypeScript puro, sem APIs do Deno: roda nas Edge Functions e no Node (testes e
 * simulador). O WhatsApp (envio, "digitando…", áudio) fica na fase 3.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { GuestRepository, IdentityRequest, Memory, RsvpChange, StoredMessage } from '../repo.ts';
import { DEFAULT_CONFIG, TIME_ZONE, type AgentConfig } from './config.ts';
import { buildContextMessage, daysUntilEvent, formatInbound, type InboundMessage } from './context.ts';
import { splitReply } from './format.ts';
import { runAgentLoop, emptyUsage, type LoopStop, type Usage } from './loop.ts';
import { rotateIfStale, type Logger, type MessagesClient } from './memory.ts';
import { FIXED_REPLIES, FOLLOW_UP_NUDGE, followUpInstruction, NO_FOLLOW_UP } from './prompt.ts';
import { collectFoundGuestIds, emptyEffects, type ProfetaAccess } from './tools.ts';

export type { InboundMessage } from './context.ts';
export type { Logger, MessagesClient } from './memory.ts';
export type { Usage } from './loop.ts';

export interface AgentDeps {
  repo: GuestRepository;
  client: MessagesClient;
  config?: Partial<AgentConfig>;
  log?: Logger;
  clock?: () => Date;
  /** O Profeta Diário (ferramenta ver_profeta_diario); sem ele, a ferramenta diz que ainda não está no ar. */
  profeta?: ProfetaAccess | null;
}

export interface TurnInput {
  /** Telefone do remetente (dígitos), já validado pelo webhook. */
  phone: string;
  /** Mensagens pendentes do contato, em ordem (respondidas juntas). */
  messages: InboundMessage[];
}

export type TurnOutcome = 'replied' | 'limited' | 'refusal' | 'error' | 'no_follow_up';

export interface TurnResult {
  /** Mensagens a enviar, em ordem. */
  replies: string[];
  /** Reação à última mensagem do convidado. */
  reaction: { emoji: string; waMessageId: string } | null;
  /** Avisos para os organizadores. */
  forwards: string[];
  /** Pedidos de identidade novos: viram aviso numerado ("aceitar N" / "recusar N"). */
  identityRequests: IdentityRequest[];
  /** Respostas que mudaram de fato no banco. */
  rsvpChanges: RsvpChange[];
  outcome: TurnOutcome;
  stop: LoopStop | null;
  usage: Usage;
}

const textMessage = (text: string): Anthropic.MessageParam => ({ role: 'assistant', content: [{ type: 'text', text }] });

const hourIn = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', hourCycle: 'h23' });

export function createAgent(deps: AgentDeps) {
  const config: AgentConfig = { ...DEFAULT_CONFIG, ...deps.config };
  const log: Logger = deps.log ?? (() => {});
  const clock = deps.clock ?? (() => new Date());
  const { repo, client } = deps;
  const empty = () => ({ reaction: null, forwards: [], identityRequests: [], rsvpChanges: [], stop: null, usage: emptyUsage() });

  /** Uma rodada com o modelo: grava [user, system, ...produzido] e devolve o resultado. */
  async function converse(args: {
    phone: string;
    memory: Memory;
    sessionId: string;
    userContent: string;
    extraContext: string | null;
    waMessageId: string | null;
    newTurn: boolean;
    /** Retomada: falhas não viram mensagem nem aviso (a pessoa nem escreveu). */
    quiet: boolean;
    now: Date;
  }): Promise<{ result: TurnResult; text: string }> {
    const { phone, memory, sessionId, now } = args;
    const history = (memory.session?.messages ?? []) as Anthropic.MessageParam[];
    const household = await repo.householdStatus(phone);
    const request = await repo.identityRequestStatus(phone);
    const context = buildContextMessage(household, memory, now, request);

    const userMessage: Anthropic.MessageParam = { role: 'user', content: args.userContent };
    const contextMessage: Anthropic.MessageParam = {
      role: 'system',
      content: args.extraContext ? `${context}\n\n${args.extraContext}` : context,
    };

    const effects = emptyEffects();
    const loop = await runAgentLoop({
      client,
      config,
      messages: [...history, userMessage, contextMessage],
      toolContext: {
        repo,
        phone,
        waMessageId: args.waMessageId,
        foundGuestIds: collectFoundGuestIds(history as StoredMessage[]),
        effects,
        calls: new Map(),
        profeta: deps.profeta ?? null,
      },
      log,
    });

    // O turno gravado sempre termina numa mensagem do assistente com o que foi enviado.
    const stored: Anthropic.MessageParam[] = [userMessage, contextMessage, ...loop.produced];
    let outcome: TurnOutcome = 'replied';
    let text = loop.text;
    if (loop.stop === 'refusal') {
      outcome = 'refusal';
      text = args.quiet ? NO_FOLLOW_UP : FIXED_REPLIES.refusal;
      if (!args.quiet) {
        effects.forwards.push('A Aifos não pôde responder a uma mensagem deste contato (recusa de segurança do modelo). Vale falar com a pessoa.');
      }
    } else if (loop.stop === 'error') {
      outcome = 'error';
      text = args.quiet ? NO_FOLLOW_UP : FIXED_REPLIES.error;
    } else if (!text && stored.at(-1)?.role !== 'assistant') {
      text = args.quiet ? NO_FOLLOW_UP : FIXED_REPLIES.error;
    }
    if (stored.at(-1)?.role !== 'assistant') stored.push(textMessage(text));

    await repo.appendMessages(sessionId, stored as StoredMessage[], args.newTurn);
    if (outcome === 'refusal') {
      // Começa do zero na próxima mensagem, sem reenviar o que causou a recusa.
      await repo.closeSession(sessionId, 'Conversa encerrada: a Aifos não pôde responder e avisou a família.');
    }

    const emoji = effects.systemReaction ?? effects.agentReaction;
    log('turn', { outcome, stop: loop.stop, iterations: loop.iterations, followUp: !args.newTurn, ...loop.usage });
    return {
      text,
      result: {
        replies: text ? splitReply(text) : [],
        reaction: emoji && args.waMessageId ? { emoji, waMessageId: args.waMessageId } : null,
        forwards: effects.forwards,
        identityRequests: effects.identityRequests,
        rsvpChanges: effects.rsvpChanges,
        outcome,
        stop: loop.stop,
        usage: loop.usage,
      },
    };
  }

  async function handleTurn({ phone, messages }: TurnInput): Promise<TurnResult> {
    const lastMessage = messages.at(-1);
    if (!lastMessage) return { ...empty(), replies: [], outcome: 'replied' };

    const allowance = await repo.consumeTurn(phone);
    if (!allowance.allowed) {
      log('limited', { reason: allowance.reason });
      if (allowance.reason === 'unknown_contact') throw new Error('Contato inexistente: grave a mensagem no inbox antes.');
      const text = allowance.reason === 'phone_limit' ? FIXED_REPLIES.phoneLimit : FIXED_REPLIES.globalLimit;
      return { ...empty(), replies: [text], outcome: 'limited' };
    }

    const now = clock();
    let memory = await repo.loadMemory(phone, config.summariesInContext);
    memory = await rotateIfStale({ repo, client, config, phone, memory, now, log });
    const sessionId = memory.session?.id ?? (await repo.openSession(phone));

    const { result } = await converse({
      phone,
      memory,
      sessionId,
      userContent: formatInbound(messages) || '[mensagem vazia]',
      extraContext: null,
      waMessageId: lastMessage.waMessageId,
      newTurn: true,
      quiet: false,
      now,
    });
    return result;
  }

  /** Dentro do horário permitido e antes da festa? (O cron pode rodar a qualquer hora.) */
  function canFollowUpNow(now = clock()): boolean {
    const hour = Number(hourIn.format(now));
    const [start, end] = config.followUpHours;
    return hour >= start && hour < end && daysUntilEvent(now) >= 0;
  }

  /** Candidatos à retomada, pela janela de silêncio da configuração. */
  function followUpCandidates(limit = 20): Promise<string[]> {
    return repo.followUpCandidates(
      Math.round(config.followUpAfterMs / 60_000),
      Math.round(config.followUpWithinMs / 60_000),
      limit,
    );
  }

  /**
   * Retoma a conversa parada de um contato. Não consome o teto diário da pessoa
   * (não foi ela quem escreveu) e não roda a rotação de sessão: a retomada
   * precisa do histórico, e a resposta da pessoa continua na mesma sessão.
   * Se o agente responder NO_FOLLOW_UP, nada é enviado.
   */
  async function followUp(phone: string): Promise<TurnResult> {
    const now = clock();
    const memory = await repo.loadMemory(phone, config.summariesInContext);
    const session = memory.session;
    const last = session?.messages.at(-1);
    if (!session || last?.role !== 'assistant') return { ...empty(), replies: [], outcome: 'no_follow_up' };

    const idleHours = Math.max(1, Math.round((now.getTime() - new Date(session.last_message_at).getTime()) / 3_600_000));
    // Marca antes de chamar o modelo: em caso de erro, não tenta de novo em loop.
    await repo.markFollowedUp(session.id);
    const { text, result } = await converse({
      phone,
      memory,
      sessionId: session.id,
      userContent: FOLLOW_UP_NUDGE,
      extraContext: followUpInstruction(idleHours),
      waMessageId: null,
      newTurn: false,
      quiet: true,
      now,
    });

    const silent = result.outcome !== 'replied' || !text || text.includes(NO_FOLLOW_UP);
    if (silent) return { ...result, replies: [], outcome: result.outcome === 'replied' ? 'no_follow_up' : result.outcome };
    return result;
  }

  return { handleTurn, followUp, followUpCandidates, canFollowUpNow, config };
}

export type Agent = ReturnType<typeof createAgent>;
