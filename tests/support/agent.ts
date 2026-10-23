/**
 * Apoio aos testes do agente: cliente Anthropic falso (respostas roteirizadas,
 * requisições registradas) e banco PGlite com as migrações reais e convidados
 * fictícios.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { PGlite } from '@electric-sql/pglite';
import { createDevDatabase, DEMO_PHONES, pgliteRpc, resetDevData } from '../../scripts/lib/pglite-db.ts';
import type { InboundMessage, MessagesClient } from '../../supabase/functions/_shared/agent/index.ts';
import { createRepository, type GuestRepository, type Rpc } from '../../supabase/functions/_shared/repo.ts';

export { DEMO_PHONES };

type Step = Anthropic.Message | ((params: Anthropic.MessageCreateParamsNonStreaming) => Anthropic.Message | Error);

export class FakeClient implements MessagesClient {
  readonly requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  private readonly steps: Step[] = [];

  constructor(...steps: Step[]) {
    this.steps.push(...steps);
  }

  then(...steps: Step[]): this {
    this.steps.push(...steps);
    return this;
  }

  get pending(): number {
    return this.steps.length;
  }

  readonly messages = {
    create: async (params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> => {
      // Cópia profunda: o agente não pode mexer no que já enviou.
      this.requests.push(structuredClone(params));
      const step = this.steps.shift();
      if (!step) throw new Error('FakeClient: nenhuma resposta roteirizada para esta chamada');
      const out = typeof step === 'function' ? step(params) : step;
      if (out instanceof Error) throw out;
      return structuredClone(out);
    },
  };
}

let seq = 0;

export function reply(
  content: Anthropic.ContentBlock[],
  stop_reason: Anthropic.StopReason = 'end_turn',
  extra: Partial<Anthropic.Message> = {},
): Anthropic.Message {
  return {
    id: `msg_${++seq}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 50 },
    ...extra,
  } as Anthropic.Message;
}

export const thinking = (): Anthropic.ContentBlock =>
  ({ type: 'thinking', thinking: '', signature: `sig_${++seq}` }) as Anthropic.ContentBlock;

export const text = (t: string): Anthropic.ContentBlock => ({ type: 'text', text: t, citations: null }) as Anthropic.ContentBlock;

export const toolUse = (name: string, input: Record<string, unknown>, id = `toolu_${++seq}`): Anthropic.ContentBlock =>
  ({ type: 'tool_use', id, name, input }) as Anthropic.ContentBlock;

/** Resposta final simples: raciocínio + texto. */
export const say = (t: string) => reply([thinking(), text(t)]);

/** Chamada de ferramenta: raciocínio + tool_use. */
export const call = (name: string, input: Record<string, unknown>) => reply([thinking(), toolUse(name, input)], 'tool_use');

export function inbound(body: string, kind: InboundMessage['kind'] = 'text'): InboundMessage {
  return { waMessageId: `wamid_${++seq}`, kind, text: body };
}

export interface TestDb {
  db: PGlite;
  rpc: Rpc;
  repo: GuestRepository;
  reset(): Promise<void>;
  guestId(fullName: string): Promise<string>;
  statusOf(fullName: string): Promise<string>;
  /** Registra o contato como o webhook faria (bot_inbox_add). */
  touch(phone: string, pushName?: string): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const db = await createDevDatabase();
  const rpc = pgliteRpc(db);
  const repo = createRepository(rpc);
  return {
    db,
    rpc,
    repo,
    reset: () => resetDevData(db, rpc),
    guestId: async (name) =>
      (await db.query<{ id: string }>('select id from public.guests where full_name = $1', [name])).rows[0]!.id,
    statusOf: async (name) =>
      (await db.query<{ rsvp_status: string }>('select rsvp_status from public.guests where full_name = $1', [name])).rows[0]!
        .rsvp_status,
    touch: async (phone, pushName = 'Contato') => {
      await rpc('bot_inbox_add', {
        p_wa_message_id: `touch_${++seq}`,
        p_phone: phone,
        p_push_name: pushName,
        p_kind: 'text',
        p_body: null,
      });
    },
  };
}

/** Texto de uma mensagem (string ou blocos). */
export function contentText(m: Anthropic.MessageParam): string {
  if (typeof m.content === 'string') return m.content;
  return m.content.map((b) => ('text' in b ? b.text : '')).join('');
}
