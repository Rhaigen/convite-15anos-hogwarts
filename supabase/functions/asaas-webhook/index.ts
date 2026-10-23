/**
 * Lista de presentes: recebe do Asaas o resultado dos checkouts (pago, cancelado,
 * expirado, estornado). Deploy sem verificação de JWT: quem autentica é o token do
 * painel do Asaas no cabeçalho asaas-access-token.
 * Secrets: ASAAS_WEBHOOK_TOKEN; ASAAS_API_URL e ASAAS_API_KEY (nome de quem pagou). Ver docs/arquitetura.md#lista-de-presentes.
 */
import { createClient } from '@supabase/supabase-js';
import { supabaseRpc } from '../_shared/repo.ts';
import { createAsaasWebhookHandler } from '../_shared/gifts/webhook.ts';

const env = (name: string) => Deno.env.get(name) ?? '';

const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_SECRET_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

Deno.serve(
  createAsaasWebhookHandler({
    rpc: supabaseRpc(supabase),
    token: env('ASAAS_WEBHOOK_TOKEN'),
    asaas: { apiUrl: env('ASAAS_API_URL'), apiKey: env('ASAAS_API_KEY') },
    log: (event, data = {}) => console.error(JSON.stringify({ fn: 'asaas-webhook', event, ...data })),
  }),
);
