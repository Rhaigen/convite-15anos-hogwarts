/**
 * Avaliação da Professora Aifos (`npm run agent:eval`): roda os cenários de
 * `agent-eval-scenarios.ts` com o Claude Haiku 5.5 de verdade, cada um num banco
 * PGlite próprio com as migrações reais e os convidados fictícios, e confere o
 * banco, as ferramentas chamadas, a reação e o texto.
 *
 *   npm run agent:eval [-- --cenario injecao,sapo] [--vezes 3] [--effort low|medium|high] [--paralelo 4]
 *
 * Custa centavos por rodada (o total aparece no fim). Transcrições completas em
 * test-results/agent-eval/. Sai com código 1 se alguma checagem falhar.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { createAgent, type MessagesClient, type Usage } from '../../supabase/functions/_shared/agent/index.ts';
import { DEFAULT_CONFIG, type Effort } from '../../supabase/functions/_shared/agent/config.ts';
import { createRepository } from '../../supabase/functions/_shared/repo.ts';
import { cost } from './agent-sim.ts';
import { EVAL_PROFETA, SCENARIOS, type Observation, type RsvpStatus, type Scenario, type TurnObservation, type Who } from './agent-eval-scenarios.ts';
import { createDevDatabase, DEMO_PHONES, passTime, pgliteRpc, resetDevData } from './pglite-db.ts';

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  gold: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const PUSH_NAMES: Record<Who, string> = { carlos: 'Carlos', marta: 'Marta', bia: 'Bia', joao: 'João', desconhecido: 'Rick' };

interface CheckResult {
  label: string;
  ok: boolean;
  detail?: string;
}

interface RunResult {
  scenario: string;
  run: number;
  checks: CheckResult[];
  turns: TurnObservation[];
  statuses: Record<string, RsvpStatus>;
  /** Erros do agente (modelo, ferramenta, recusa) registrados no log. */
  errors: string[];
  usage: Usage;
  seconds: number;
}

const emptyUsage = (): Usage => ({ requests: 0, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
const addUsage = (total: Usage, u: Usage) => {
  for (const k of Object.keys(total) as (keyof Usage)[]) total[k] += u[k];
};

async function runScenario(scenario: Scenario, run: number, effort: Effort, base: Anthropic): Promise<RunResult> {
  const started = Date.now();
  const db = await createDevDatabase();
  try {
    const rpc = pgliteRpc(db);
    await resetDevData(db, rpc);
    if (scenario.extraGuests) {
      const r = (await rpc('admin_import_guests', { p_rows: scenario.extraGuests, p_apply: true })) as { errors: unknown[] };
      if (r.errors.length > 0) throw new Error(`${scenario.id}: convidados extras recusados: ${JSON.stringify(r.errors)}`);
    }
    for (const [name, value] of Object.entries(scenario.preset ?? {})) {
      const r = await db.query('update public.guests set rsvp_status = $2 where full_name = $1', [name, value]);
      if (r.affectedRows !== 1) throw new Error(`${scenario.id}: convidado "${name}" não existe`);
    }
    for (const [name, preset] of Object.entries(scenario.presetMessages ?? {})) {
      const { body, by } = typeof preset === 'string' ? { body: preset, by: name } : preset;
      const r = await db.query(
        `insert into public.guest_messages (guest_id, written_by, body)
         select g.id, w.id, $2 from public.guests g, public.guests w where g.full_name = $1 and w.full_name = $3`,
        [name, body, by],
      );
      if (r.affectedRows !== 1) throw new Error(`${scenario.id}: convidado "${name}" não existe`);
    }
    if (scenario.closed) await db.query('update public.rsvp_settings set accepting_responses = false where id = 1');
    for (const [who, role] of Object.entries(scenario.specials ?? {})) {
      await db.query('select public.bot_ensure_special_contact($1, $2)', [DEMO_PHONES[who as Who], role]);
    }

    // Grava as ferramentas que o modelo pediu (o agente só registra o nome no log).
    const calls: { name: string; input: unknown }[] = [];
    const client: MessagesClient = {
      messages: {
        async create(params) {
          const response = await base.messages.create(params);
          for (const block of response.content) {
            if (block.type === 'tool_use') calls.push({ name: block.name, input: block.input });
          }
          return response;
        },
      },
    };
    const errors: string[] = [];
    const agent = createAgent({
      repo: createRepository(rpc),
      client,
      config: { effort },
      profeta: EVAL_PROFETA,
      log: (event, data) => {
        if (event.endsWith('_error') || event.endsWith('_failed') || event === 'refusal') {
          errors.push(`${event} ${JSON.stringify(data ?? {})}`);
        }
      },
    });

    const usage = emptyUsage();
    const turns: TurnObservation[] = [];
    let seq = 0;
    for (const step of scenario.steps) {
      if ('hours' in step) {
        await passTime(db, step.hours);
        continue;
      }
      if ('decide' in step) {
        // Como o comando do organizador: o banco decide; a mensagem fixa à pessoa não passa pelo agente.
        const pending = await db.query<{ id: number }>(
          `select id from public.identity_requests where phone = $1 and status = 'pending'`,
          [DEMO_PHONES[step.decide]],
        );
        const id = pending.rows[0]?.id;
        if (id === undefined) {
          errors.push(`decisão sem pedido pendente de ${step.decide}`);
          continue;
        }
        const r = (await rpc('bot_resolve_identity_request', {
          p_id: id,
          p_accept: step.accept,
          p_admin_phone: DEMO_PHONES.marta,
          p_guest_name: step.name ?? null,
        })) as { ok: boolean; error?: string };
        if (!r.ok) errors.push(`decisão do pedido ${id} falhou: ${r.error}`);
        continue;
      }
      const phone = DEMO_PHONES[step.as];
      const kind = step.kind ?? 'text';
      const text = step.say || null;
      const waMessageId = `eval_${scenario.id}_${++seq}`;
      // Como o webhook: grava no inbox (cria o contato com o nome do WhatsApp).
      await rpc('bot_inbox_add', { p_wa_message_id: waMessageId, p_phone: phone, p_push_name: PUSH_NAMES[step.as], p_kind: kind, p_body: text });
      const before = calls.length;
      const r = await agent.handleTurn({ phone, messages: [{ waMessageId, kind, text }] });
      await db.query('update public.wa_inbox set processed_at = now() where wa_message_id = $1', [waMessageId]);
      addUsage(usage, r.usage);
      turns.push({
        who: step.as,
        said: step.say || `[${kind}]`,
        text: r.replies.join('\n\n'),
        tools: calls.slice(before),
        reaction: r.reaction?.emoji ?? null,
        changes: r.rsvpChanges,
        forwards: r.forwards,
        identityRequests: r.identityRequests.length,
        outcome: r.outcome,
      });
    }

    const statusRows = await db.query<{ full_name: string; rsvp_status: RsvpStatus }>('select full_name, rsvp_status from public.guests');
    const statuses = Object.fromEntries(statusRows.rows.map((g) => [g.full_name, g.rsvp_status]));
    const linkRows = await db.query<{ phone: string; full_name: string | null }>(
      `select c.phone, g.full_name from public.wa_contacts c left join public.guests g on g.id = c.linked_guest_id`,
    );
    const linked: Observation['linked'] = {};
    for (const [who, phone] of Object.entries(DEMO_PHONES) as [Who, string][]) {
      const row = linkRows.rows.find((x) => x.phone === phone);
      if (row) linked[who] = row.full_name;
    }

    const messageRows = await db.query<{
      full_name: string;
      body: string;
      signature: string | null;
      source: 'text' | 'audio';
      by: string | null;
    }>(
      `select g.full_name, m.body, m.signature, m.source, w.full_name as by
         from public.guest_messages m
         join public.guests g on g.id = m.guest_id
         left join public.guests w on w.id = m.written_by`,
    );
    const messages = Object.fromEntries(messageRows.rows.map(({ full_name, ...m }) => [full_name, m]));

    const requestRows = await db.query<{ phone: string; claimed_name: string; guest_name: string | null; status: 'pending' | 'accepted' | 'rejected' }>(
      `select r.phone, r.claimed_name, g.full_name as guest_name, r.status
         from public.identity_requests r left join public.guests g on g.id = r.guest_id order by r.id`,
    );
    const requests = requestRows.rows.map(({ phone, ...r }) => ({
      who: ((Object.entries(DEMO_PHONES) as [Who, string][]).find(([, p]) => p === phone)?.[0] ?? null) as Who | null,
      ...r,
    }));

    const observation: Observation = { turns, statuses, linked, messages, requests };
    const checks = scenario.checks.map((check): CheckResult => {
      try {
        const r = check.test(observation);
        return r === true ? { label: check.label, ok: true } : { label: check.label, ok: false, detail: r };
      } catch (error) {
        return { label: check.label, ok: false, detail: `erro na checagem: ${String(error)}` };
      }
    });
    if (turns.some((t) => t.outcome !== 'replied')) {
      checks.push({ label: 'todos os turnos respondidos', ok: false, detail: turns.map((t) => t.outcome).join(', ') });
    }
    return { scenario: scenario.id, run, checks, turns, statuses, errors, usage, seconds: (Date.now() - started) / 1000 };
  } finally {
    await db.close();
  }
}

/** Executa as tarefas com no máximo `limit` ao mesmo tempo, mantendo a ordem dos resultados. */
async function pool<T>(tasks: (() => Promise<T>)[], limit: number, onDone: (r: T) => void): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]!();
      onDone(results[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

function printTranscript(r: RunResult): void {
  for (const t of r.turns) {
    console.log(c.dim(`      ${t.who} › ${t.said}`));
    const extras = [
      t.tools.length ? `ferramentas: ${t.tools.map((x) => x.name).join(', ')}` : '',
      t.reaction ? `reação ${t.reaction}` : '',
      t.changes.length ? `banco: ${t.changes.map((x) => `${x.full_name} → ${x.rsvp_status}`).join(', ')}` : '',
    ].filter(Boolean);
    console.log(c.gold(`      Aifos › ${t.text.replace(/\n+/g, ' ⏎ ')}`));
    if (extras.length) console.log(c.dim(`              [${extras.join(' · ')}]`));
  }
  for (const e of r.errors) console.log(c.red(`      · ${e}`));
}

export async function main(argv: string[]): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY && existsSync('supabase/functions/.env')) {
    process.loadEnvFile('supabase/functions/.env');
  }
  const arg = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const effort = (arg('effort') ?? DEFAULT_CONFIG.effort) as Effort;
  const runs = Math.max(1, Number(arg('vezes') ?? 1));
  const parallel = Math.max(1, Number(arg('paralelo') ?? 4));
  const only = arg('cenario')?.split(',').map((s) => s.trim());

  const unknown = only?.filter((id) => !SCENARIOS.some((s) => s.id === id)) ?? [];
  if (unknown.length) {
    console.log(c.red(`Cenário desconhecido: ${unknown.join(', ')}. Disponíveis: ${SCENARIOS.map((s) => s.id).join(', ')}`));
    process.exitCode = 2;
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.log(c.red('Sem ANTHROPIC_API_KEY (nem no ambiente, nem em supabase/functions/.env).'));
    process.exitCode = 2;
    return;
  }

  const scenarios = only ? SCENARIOS.filter((s) => only.includes(s.id)) : SCENARIOS;
  const base = new Anthropic();
  const started = Date.now();
  console.log(
    c.bold('🦉 Avaliação da Professora Aifos') +
      c.dim(` (${DEFAULT_CONFIG.model}, esforço ${effort}; ${scenarios.length} cenário(s) × ${runs}, ${parallel} em paralelo)\n`),
  );

  const tasks = scenarios.flatMap((s) => Array.from({ length: runs }, (_, i) => () => runScenario(s, i + 1, effort, base)));
  const results = await pool(tasks, parallel, (r) => {
    const failed = r.checks.filter((x) => !x.ok);
    const title = SCENARIOS.find((s) => s.id === r.scenario)!.title;
    const mark = failed.length ? c.red('✗') : c.green('✓');
    const run = runs > 1 ? ` #${r.run}` : '';
    console.log(
      `${mark} ${r.scenario}${run} ${c.dim(`— ${title} · ${r.checks.length - failed.length}/${r.checks.length} · ${r.seconds.toFixed(1)} s · US$ ${cost(r.usage).toFixed(4)}`)}`,
    );
    for (const f of failed) console.log(c.red(`    ✗ ${f.label}: ${f.detail}`));
    if (failed.length || r.errors.length) printTranscript(r);
  });

  // Resumo: taxa de acerto por checagem quando há repetições.
  const total = emptyUsage();
  for (const r of results) addUsage(total, r.usage);
  const allChecks = results.flatMap((r) => r.checks);
  const passed = allChecks.filter((x) => x.ok).length;
  const scenariosOk = results.filter((r) => r.checks.every((x) => x.ok)).length;

  if (runs > 1) {
    console.log(c.bold('\nChecagens instáveis (acertos/execuções):'));
    let any = false;
    for (const s of scenarios) {
      const mine = results.filter((r) => r.scenario === s.id);
      for (const label of new Set(mine.flatMap((r) => r.checks.map((x) => x.label)))) {
        const ok = mine.filter((r) => r.checks.find((x) => x.label === label)?.ok).length;
        if (ok < mine.length) {
          any = true;
          console.log(`  ${s.id} · ${label}: ${ok}/${mine.length}`);
        }
      }
    }
    if (!any) console.log(c.dim('  nenhuma'));
  }

  const seconds = (Date.now() - started) / 1000;
  const color = passed === allChecks.length ? c.green : c.red;
  console.log(
    `\n${color(`${passed}/${allChecks.length} checagens · ${scenariosOk}/${results.length} cenários sem falha`)}` +
      c.dim(` · ${total.requests} chamadas · US$ ${cost(total).toFixed(4)} · ${seconds.toFixed(0)} s`),
  );

  const dir = join('test-results', 'agent-eval');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(
    file,
    JSON.stringify({ model: DEFAULT_CONFIG.model, effort, runs, passed, checks: allChecks.length, usage: total, costUsd: cost(total), results }, null, 2),
  );
  console.log(c.dim(`Transcrições: ${file}`));
  if (passed < allChecks.length) process.exitCode = 1;
}
