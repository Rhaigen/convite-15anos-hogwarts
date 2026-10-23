/**
 * Simulador da Professora Aifos no terminal (`npm run agent:chat`).
 *
 * Conversa com o agente REAL (Claude Haiku 5.5, chave em ANTHROPIC_API_KEY ou em
 * supabase/functions/.env) sobre um banco PGlite em memória com as migrações reais
 * e convidados FICTÍCIOS. Sem WhatsApp: as respostas, reações e avisos à família
 * aparecem aqui. Cada mensagem custa frações de centavo.
 */
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import Anthropic from '@anthropic-ai/sdk';
import { createAgent, type InboundMessage, type TurnResult, type Usage } from '../../supabase/functions/_shared/agent/index.ts';
import type { Effort } from '../../supabase/functions/_shared/agent/config.ts';
import { IDENTITY_REPLIES } from '../../supabase/functions/_shared/agent/prompt.ts';
import { createRepository } from '../../supabase/functions/_shared/repo.ts';
import { parseIdentityCommand } from '../../supabase/functions/_shared/whatsapp/bot.ts';
import {
  formatIdentityDecision,
  formatIdentityRequest,
  suggestionQuery,
  type GuestSuggestion,
  type IdentityDecision,
} from '../../supabase/functions/_shared/whatsapp/report.ts';
import { createDevDatabase, DEMO_GUESTS, DEMO_PHONES, passTime, pgliteRpc, resetDevData } from './pglite-db.ts';

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  gold: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

// Claude Haiku 5.5 (prompts até 100 mil tokens), US$ por milhão de tokens.
const PRICE = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 };

export function cost(u: Usage): number {
  return (
    (u.input_tokens * PRICE.input +
      u.output_tokens * PRICE.output +
      u.cache_read_input_tokens * PRICE.cacheRead +
      u.cache_creation_input_tokens * PRICE.cacheWrite) /
    1_000_000
  );
}

const HELP = `Comandos:
  /como <${Object.keys(DEMO_PHONES).join('|')}>   troca quem está escrevendo
  /audio <texto>     envia como áudio transcrito
  /imagem            envia uma imagem (a Aifos não enxerga imagens)
  /tempo <horas>     faz o tempo passar (a sessão esfria e vira resumo após 12 h)
  /retomar           a Aifos retoma a conversa parada (no WhatsApp, o cron faz isso
                     sozinho após 3 h de silêncio, das 9h às 21h; aqui ignora horário)
  /aceitar <N> [nome]  decide como organizador o pedido de identidade N ("aceitar N" no WhatsApp)
  /recusar <N>
  /situacao          respostas gravadas no banco
  /memoria           notas, resumos e sessão do contato atual
  /prazo <abrir|encerrar>
  /custo             tokens e custo acumulados
  /ajuda  /sair`;

export async function main(argv: string[]): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY && existsSync('supabase/functions/.env')) {
    process.loadEnvFile('supabase/functions/.env');
  }
  const arg = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const effort = (arg('effort') ?? 'medium') as Effort;
  const verbose = argv.includes('--verbose');
  let who = (arg('como') ?? 'carlos') as keyof typeof DEMO_PHONES;

  console.log(c.dim('Preparando o banco de teste (PGlite + migrações)…'));
  const db = await createDevDatabase();
  const rpc = pgliteRpc(db);
  await resetDevData(db, rpc);
  const repo = createRepository(rpc);
  const suggestGuests = async (name: string | null) =>
    name ? ((await rpc('bot_suggest_guest_names', { p_name: name })) as GuestSuggestion[]) : [];
  const agent = createAgent({
    repo,
    client: new Anthropic(),
    config: { effort },
    // Palavra mágica FICTÍCIA no simulador (a de verdade fica só nos secrets).
    profeta: { url: 'https://convite.example.com/profeta/', password: 'Pomo Fictício' },
    log: (event, data) => {
      const isError = event.endsWith('_error') || event.endsWith('_failed');
      if (isError || verbose) console.log((isError ? c.red : c.dim)(`  · ${event} ${data ? JSON.stringify(data) : ''}`));
    },
  });

  const total: Usage = { requests: 0, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  let seq = 0;

  console.log(c.bold('\n🦉 Simulador da Professora Aifos') + c.dim(` (claude-haiku-5-5, esforço ${effort})`));
  console.log(c.dim('Convidados fictícios:'));
  for (const g of DEMO_GUESTS) {
    console.log(c.dim(`  ${g.household} · ${g.full_name}${g.is_minor ? ' (menor)' : ''}${g.phone ? ` · ${g.phone}` : ' · sem telefone'}`));
  }
  console.log(c.dim(`\n${HELP}\n`));

  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.log(c.red('Sem ANTHROPIC_API_KEY (nem no ambiente, nem em supabase/functions/.env): só os comandos locais vão funcionar.\n'));
  }

  const rl = createInterface({ input: stdin, output: stdout });
  const prompt = () => {
    rl.setPrompt(c.cyan(`${who} › `));
    rl.prompt();
  };
  prompt();
  try {
    // Iterar as linhas (em vez de rl.question) não perde entrada colada de uma vez.
    for await (const raw of rl) {
      const line = raw.trim();
      const phone = DEMO_PHONES[who];
      if (!line) {
        prompt();
        continue;
      }

      if (line.startsWith('/')) {
        const [cmd, ...rest] = line.slice(1).split(' ');
        const value = rest.join(' ').trim();
        if (cmd === 'sair') break;
        if (cmd === 'ajuda') console.log(HELP);
        else if (cmd === 'como') {
          if (value in DEMO_PHONES) who = value as keyof typeof DEMO_PHONES;
          else console.log(c.red(`Use: /como ${Object.keys(DEMO_PHONES).join('|')}`));
        } else if (cmd === 'tempo') {
          const hours = Number(value);
          if (!Number.isFinite(hours) || hours <= 0) console.log(c.red('Use: /tempo 13'));
          else {
            await passTime(db, hours);
            console.log(c.dim(`⏳ Passaram-se ${Math.round(hours)} h para todas as conversas abertas.`));
          }
        } else if (cmd === 'aceitar' || cmd === 'recusar') {
          const command = parseIdentityCommand(`${cmd} ${value}`);
          if (!command) console.log(c.red(`Use: /${cmd} 12${cmd === 'aceitar' ? ' [nome como está na lista]' : ''}`));
          else {
            const decision = (await rpc('bot_resolve_identity_request', {
              p_id: command.id,
              p_accept: command.accept,
              p_admin_phone: DEMO_PHONES.marta,
              p_guest_name: command.name,
            })) as IdentityDecision;
            const suggestions = await suggestGuests(suggestionQuery(decision, command.name));
            console.log(
              c.gold(`  [organizador: ${formatIdentityDecision(command.id, decision, DEMO_PHONES.marta, command.name, suggestions)}]`),
            );
            if (decision.ok) {
              const notice =
                decision.status === 'accepted' ? IDENTITY_REPLIES.accepted(decision.guest_name.split(' ')[0]!) : IDENTITY_REPLIES.rejected;
              console.log(`${c.gold('Aifos ›')} ${c.dim('(mensagem fixa)')} ${notice.replace(/\n/g, '\n         ')}`);
            }
          }
        } else if (cmd === 'situacao') {
          const r = await db.query<{ household: string; full_name: string; rsvp_status: string }>(
            `select h.label as household, g.full_name, g.rsvp_status
               from public.guests g join public.households h on h.id = g.household_id order by h.label, g.full_name`,
          );
          for (const g of r.rows) console.log(`  ${g.household} · ${g.full_name}: ${g.rsvp_status}`);
        } else if (cmd === 'memoria') {
          console.log(JSON.stringify(await repo.loadMemory(phone), (k, v) => (k === 'messages' ? `[${v.length} mensagens]` : v), 2));
        } else if (cmd === 'prazo') {
          await db.query('update public.rsvp_settings set accepting_responses = $1 where id = 1', [value !== 'encerrar']);
          console.log(c.dim(value === 'encerrar' ? 'Confirmações encerradas.' : 'Confirmações abertas.'));
        } else if (cmd === 'custo') {
          console.log(`  ${total.requests} chamadas · US$ ${cost(total).toFixed(4)} · ${JSON.stringify(total)}`);
        } else if (cmd === 'retomar') {
          const waiting = await agent.followUpCandidates(100);
          if (!waiting.includes(phone)) console.log(c.dim('  (fora da janela de 3 h a 24 h de silêncio; retomando mesmo assim)'));
          await show(() => agent.followUp(phone));
        } else if (cmd === 'audio' || cmd === 'imagem') {
          await turn(phone, cmd === 'audio' ? 'audio' : 'image', value || null);
        } else console.log(c.red('Comando desconhecido. /ajuda'));
        prompt();
        continue;
      }
      await turn(phone, 'text', line);
      prompt();
    }
  } finally {
    rl.close();
    await db.close();
  }

  async function turn(phone: string, kind: InboundMessage['kind'], body: string | null): Promise<void> {
    const msg: InboundMessage = { waMessageId: `sim_${++seq}`, kind, text: body };
    // Como o webhook: grava no inbox (cria o contato com o nome do WhatsApp).
    await rpc('bot_inbox_add', {
      p_wa_message_id: msg.waMessageId,
      p_phone: phone,
      p_push_name: who[0]!.toUpperCase() + who.slice(1),
      p_kind: kind,
      p_body: body,
    });
    await show(() => agent.handleTurn({ phone, messages: [msg] }));
    await db.query('update public.wa_inbox set processed_at = now() where wa_message_id = $1', [msg.waMessageId]);
  }

  async function show(run: () => Promise<TurnResult>): Promise<void> {
    const started = Date.now();
    try {
      const r = await run();
      for (const k of Object.keys(total) as (keyof Usage)[]) total[k] += r.usage[k];
      if (r.reaction) console.log(c.dim(`  [reagiu ${r.reaction.emoji}]`));
      for (const text of r.replies) console.log(`${c.gold('Aifos ›')} ${text.replace(/\n/g, '\n         ')}`);
      for (const ch of r.rsvpChanges) console.log(c.dim(`  [banco: ${ch.full_name} ${ch.previous_status} → ${ch.rsvp_status}]`));
      for (const f of r.forwards) console.log(c.gold(`  [aviso à família: ${f}]`));
      for (const q of r.identityRequests) {
        const suggestions = q.guest_name ? [] : await suggestGuests(q.claimed_name);
        console.log(c.gold(`  [aos organizadores:\n${formatIdentityRequest(q, suggestions)}]`));
      }
      const u = r.usage;
      console.log(
        c.dim(
          `  ${r.outcome}/${r.stop} · ${u.requests} chamada(s) · ${((Date.now() - started) / 1000).toFixed(1)} s · ` +
            `entrada ${u.input_tokens} + cache ${u.cache_read_input_tokens} lido/${u.cache_creation_input_tokens} gravado · ` +
            `saída ${u.output_tokens} · US$ ${cost(u).toFixed(5)}`,
        ),
      );
    } catch (error) {
      console.log(c.red(`Erro: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
}
