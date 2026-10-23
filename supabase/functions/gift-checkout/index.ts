/**
 * Lista de presentes: cria o checkout do Asaas para um presente e devolve o link.
 * Deploy sem verificação de JWT (o site não tem chave): o preço vem do catálogo do
 * servidor, a origem precisa ser a do convite e o banco limita as tentativas.
 * Secrets: SITE_ORIGINS, SITE_URL, ASAAS_API_URL, ASAAS_API_KEY, GIFT_IP_SALT.
 * Ver docs/arquitetura.md#lista-de-presentes.
 */
import { createClient } from '@supabase/supabase-js';
import { supabaseRpc } from '../_shared/repo.ts';
import { parseOrigins } from '../_shared/siteMessages/handler.ts';
import { GIFT_CATALOG, GIFT_IMAGE_BASE64 } from '../_shared/gifts/catalog.ts';
import { createGiftCheckoutHandler } from '../_shared/gifts/checkout.ts';

const env = (name: string) => Deno.env.get(name) ?? '';

const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_SECRET_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

Deno.serve(
  createGiftCheckoutHandler({
    rpc: supabaseRpc(supabase),
    allowedOrigins: parseOrigins(env('SITE_ORIGINS')),
    catalog: GIFT_CATALOG,
    imageBase64: GIFT_IMAGE_BASE64,
    asaas: { apiUrl: env('ASAAS_API_URL'), apiKey: env('ASAAS_API_KEY') },
    siteUrl: env('SITE_URL'),
    ipSalt: env('GIFT_IP_SALT'),
    log: (event, data = {}) => console.error(JSON.stringify({ fn: 'gift-checkout', event, ...data })),
  }),
);
