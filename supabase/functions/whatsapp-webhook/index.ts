/**
 * Webhook da Evolution API → Professora Aifos.
 * Configure na instância: URL desta função, evento MESSAGES_UPSERT, base64 desligado
 * e o cabeçalho `x-sofia-secret` com o WEBHOOK_SECRET. Deploy sem verificação de JWT
 * (a Evolution não envia JWT): a autenticação é o segredo. Ver docs/arquitetura.md#professora-aifos.
 */
import { createSofia, jsonLogger } from '../_shared/whatsapp/runtime.ts';

/** Runtime das Edge Functions do Supabase: mantém a função viva até o trabalho terminar. */
declare const EdgeRuntime: { waitUntil(work: Promise<unknown>): void };

const sofia = createSofia((name) => Deno.env.get(name), jsonLogger('whatsapp-webhook'));

Deno.serve(sofia.webhookHandler((work) => EdgeRuntime.waitUntil(work)));
