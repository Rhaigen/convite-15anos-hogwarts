/**
 * Monta a Aifos a partir das variáveis de ambiente das Edge Functions
 * (segredos em `supabase secrets`; modelo em supabase/functions/.env.example).
 * Recebe um leitor de variáveis em vez de usar `Deno.env`, para rodar também no Node.
 */
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { createAgent, type Logger } from '../agent/index.ts';
import { createRepository, supabaseRpc } from '../repo.ts';
import { createWhatsAppBot } from './bot.ts';
import { createEvolutionClient } from './evolution.ts';
import { createCronHandler, createWebhookHandler, type Background } from './http.ts';
import { parsePhoneList } from './phone.ts';
import { createProfetaClient } from './profeta.ts';
import { createOpenAiTranscriber } from './transcriber.ts';

export type Env = (name: string) => string | undefined;

function required(env: Env, name: string): string {
  const value = env(name)?.trim();
  if (!value) throw new Error(`Variável de ambiente ausente: ${name}`);
  return value;
}

/** Uma linha JSON por evento (Supabase → Edge Functions → Logs). Sem textos de conversa. */
export const jsonLogger =
  (fn: string): Logger =>
  (event, data = {}) => {
    const line = JSON.stringify({ fn, event, ...data });
    if (event.endsWith('_failed') || event.endsWith('_error') || event.endsWith('_unauthorized')) console.error(line);
    // eslint-disable-next-line no-console -- log estruturado das Edge Functions
    else console.log(line);
  };

export function createSofia(env: Env, log: Logger) {
  const supabase = createClient(
    required(env, 'SUPABASE_URL'),
    env('SUPABASE_SERVICE_ROLE_KEY') || required(env, 'SUPABASE_SECRET_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
  );
  const rpc = supabaseRpc(supabase);
  const repo = createRepository(rpc);

  // O Profeta Diário: ligado só com os secrets PROFETA_* (sem eles, tudo segue como antes).
  const profetaApi = env('PROFETA_API_URL')?.trim();
  const profetaSecret = env('PROFETA_SECRET')?.trim();
  const profetaUrl = env('PROFETA_URL')?.trim() || null;
  const profetaPassword = env('PROFETA_SENHA')?.trim();

  const agent = createAgent({
    repo,
    client: new Anthropic({ apiKey: required(env, 'ANTHROPIC_API_KEY'), maxRetries: 2, timeout: 60_000 }),
    log,
    profeta: profetaUrl && profetaPassword ? { url: profetaUrl, password: profetaPassword } : null,
  });

  const openAiKey = env('OPENAI_API_KEY')?.trim();
  const bot = createWhatsAppBot({
    rpc,
    agent,
    whatsapp: createEvolutionClient({
      baseUrl: required(env, 'EVOLUTION_API_URL'),
      apiKey: required(env, 'EVOLUTION_API_KEY'),
      instance: required(env, 'EVOLUTION_INSTANCE'),
    }),
    transcriber: openAiKey ? createOpenAiTranscriber({ apiKey: openAiKey }) : null,
    adminPhones: parsePhoneList(env('ADMIN_PHONES')),
    staffPhones: parsePhoneList(env('STAFF_PHONES')),
    profeta:
      profetaApi && profetaSecret ? { client: createProfetaClient({ apiUrl: profetaApi, secret: profetaSecret }), pageUrl: profetaUrl } : null,
    log,
  });

  return {
    rpc,
    bot,
    webhookHandler: (background: Background) =>
      createWebhookHandler({
        secret: required(env, 'WEBHOOK_SECRET'),
        instance: required(env, 'EVOLUTION_INSTANCE'),
        rpc,
        bot,
        background,
        log,
      }),
    cronHandler: (background: Background) => createCronHandler({ rpc, bot, background, log }),
  };
}
