/**
 * O Salão Principal: cartas (recados aprovados) para o site, só leitura.
 * Deploy sem verificação de JWT (o site não tem chave): a função só devolve o que
 * os organizadores aprovaram, e o texto só depois que os selos se rompem.
 * Secrets: SITE_ORIGINS (origens do convite, separadas por vírgula).
 * Ver docs/arquitetura.md#o-salao-principal.
 */
import { createClient } from '@supabase/supabase-js';
import { supabaseRpc } from '../_shared/repo.ts';
import { createSiteMessagesHandler, parseOrigins } from '../_shared/siteMessages/handler.ts';

const env = (name: string) => Deno.env.get(name) ?? '';

const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_SECRET_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

Deno.serve(
  createSiteMessagesHandler({
    rpc: supabaseRpc(supabase),
    allowedOrigins: parseOrigins(env('SITE_ORIGINS')),
    log: (event, data = {}) => console.error(JSON.stringify({ fn: 'site-messages', event, ...data })),
  }),
);
