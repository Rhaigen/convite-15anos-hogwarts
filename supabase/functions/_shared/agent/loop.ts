/**
 * Loop manual de ferramentas (sem o Tool Runner): cada passo é controlado aqui
 * para que o histórico seja só acrescentado, cada chamada de ferramenta seja
 * autorizada no código e o número de chamadas ao modelo tenha teto.
 *
 * Invariante do histórico: toda mensagem do assistente com `tool_use` é seguida
 * de uma mensagem com os `tool_result` correspondentes, mesmo quando a
 * ferramenta não roda (resposta cortada por max_tokens, erro). Assim o histórico
 * gravado é sempre válido para o próximo turno.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { AgentConfig } from './config.ts';
import type { Logger, MessagesClient } from './memory.ts';
import { SYSTEM_PROMPT } from './prompt.ts';
import { executeTool, TOOLS, type ToolContext } from './tools.ts';

export interface Usage {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export const emptyUsage = (): Usage => ({
  requests: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
});

export function addUsage(total: Usage, u: Anthropic.Usage): void {
  total.requests += 1;
  total.input_tokens += u.input_tokens;
  total.output_tokens += u.output_tokens;
  total.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
  total.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
}

export type LoopStop = 'end_turn' | 'max_tokens' | 'refusal' | 'max_iterations' | 'error' | 'other';

export interface LoopResult {
  /** Mensagens produzidas neste turno (assistente e resultados de ferramentas), na ordem. */
  produced: Anthropic.MessageParam[];
  /** Textos do assistente neste turno. */
  text: string;
  stop: LoopStop;
  iterations: number;
  usage: Usage;
  error?: unknown;
}

/** Corpo da requisição. Ordem do prefixo em cache: ferramentas → system → histórico. */
export function buildRequest(
  config: AgentConfig,
  messages: Anthropic.MessageParam[],
  forceText: boolean,
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: config.model,
    max_tokens: config.maxTokens,
    thinking: { type: 'adaptive' },
    output_config: { effort: config.effort },
    // Ponto fixo no fim do prompt estável (compartilhado por todos os contatos)
    // + cache automático na cauda da conversa.
    cache_control: { type: 'ephemeral' },
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    tools: TOOLS,
    ...(forceText ? { tool_choice: { type: 'none' as const } } : {}),
    messages,
  };
}

export async function runAgentLoop(args: {
  client: MessagesClient;
  config: AgentConfig;
  /** Histórico completo, terminando na mensagem do convidado + contexto do sistema. */
  messages: Anthropic.MessageParam[];
  toolContext: ToolContext;
  log: Logger;
}): Promise<LoopResult> {
  const { client, config, toolContext, log } = args;
  const messages = [...args.messages];
  const produced: Anthropic.MessageParam[] = [];
  const texts: string[] = [];
  const usage = emptyUsage();
  const result = (stop: LoopStop, iterations: number, error?: unknown): LoopResult => ({
    produced,
    text: texts.join('\n\n').trim(),
    stop,
    iterations,
    usage,
    ...(error === undefined ? {} : { error }),
  });

  for (let i = 0; i < config.maxIterations; i++) {
    // Na última volta o modelo só pode escrever: a pessoa sempre recebe resposta.
    const lastChance = i === config.maxIterations - 1;
    let response: Anthropic.Message;
    try {
      response = await client.messages.create(buildRequest(config, messages, lastChance));
    } catch (error) {
      log('model_error', { error: String(error), iteration: i });
      return result('error', i, error);
    }
    addUsage(usage, response.usage);

    // Recusa de segurança: a resposta (talvez parcial) é descartada, não entra no histórico.
    if (response.stop_reason === 'refusal') {
      log('refusal', { category: response.stop_details?.category ?? null });
      return result('refusal', i + 1);
    }

    const assistant: Anthropic.MessageParam = { role: 'assistant', content: response.content };
    messages.push(assistant);
    produced.push(assistant);
    for (const block of response.content) if (block.type === 'text' && block.text.trim()) texts.push(block.text.trim());

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (toolUses.length > 0) {
      const run = response.stop_reason === 'tool_use';
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        const outcome = run
          ? await executeTool(use.name, use.input, toolContext).catch((error: unknown) => {
              log('tool_error', { tool: use.name, error: String(error) });
              return { content: JSON.stringify({ ok: false, erro: 'Falha interna. Tente de novo.' }), isError: true };
            })
          : { content: JSON.stringify({ ok: false, erro: 'Não executada: a resposta foi interrompida.' }), isError: true };
        log('tool', { tool: use.name, error: outcome.isError });
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: outcome.content,
          ...(outcome.isError ? { is_error: true } : {}),
        });
      }
      const toolMessage: Anthropic.MessageParam = { role: 'user', content: results };
      messages.push(toolMessage);
      produced.push(toolMessage);
      if (run) continue;
    }

    if (response.stop_reason === 'end_turn') return result('end_turn', i + 1);
    if (response.stop_reason === 'max_tokens') return result('max_tokens', i + 1);
    return result('other', i + 1);
  }
  return result('max_iterations', config.maxIterations);
}
