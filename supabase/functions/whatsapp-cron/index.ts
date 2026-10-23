/**
 * Tarefas agendadas da Professora Aifos, chamadas pelo pg_cron
 * (migração 20261015000500_bot_cron.sql) com o segredo do Vault:
 *   {"job": "tick"}          a cada 15 min: retomadas e mensagens esquecidas na fila;
 *   {"job": "daily-report"}  todo dia às 9h: relatório aos organizadores.
 * Deploy sem verificação de JWT: a autenticação é o segredo `x-cron-secret`.
 */
import { createSofia, jsonLogger } from '../_shared/whatsapp/runtime.ts';

/** Runtime das Edge Functions do Supabase: mantém a função viva até o trabalho terminar. */
declare const EdgeRuntime: { waitUntil(work: Promise<unknown>): void };

const sofia = createSofia((name) => Deno.env.get(name), jsonLogger('whatsapp-cron'));

Deno.serve(sofia.cronHandler((work) => EdgeRuntime.waitUntil(work)));
