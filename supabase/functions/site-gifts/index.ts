/**
 * Lista de presentes: progresso das vaquinhas para o site, só leitura.
 * Deploy sem verificação de JWT (o site não tem chave): só somas de pedidos pagos.
 * Secrets: SITE_ORIGINS. Ver docs/arquitetura.md#lista-de-presentes.
 */
import { createClient } from '@supabase/supabase-js';
import { supabaseRpc } from '../_shared/repo.ts';
import { parseOrigins } from '../_shared/siteMessages/handler.ts';
import { GIFT_CATALOG } from '../_shared/gifts/catalog.ts';
import { createSiteGiftsHandler } from '../_shared/gifts/progress.ts';

const env = (name: string) => Deno.env.get(name) ?? '';

const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_SECRET_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

Deno.serve(
  createSiteGiftsHandler({
    rpc: supabaseRpc(supabase),
    allowedOrigins: parseOrigins(env('SITE_ORIGINS')),
    catalog: GIFT_CATALOG,
    log: (event, data = {}) => console.error(JSON.stringify({ fn: 'site-gifts', event, ...data })),
  }),
);
