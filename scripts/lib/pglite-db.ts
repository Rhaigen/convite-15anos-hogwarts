/**
 * Banco de desenvolvimento da Aifos: Postgres embutido (PGlite + pg_trgm + fuzzystrmatch) com as
 * migrações reais e os papéis do Supabase. Usado pelos testes do agente e pelo
 * simulador `npm run agent:chat`. Os convidados daqui são FICTÍCIOS.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { fuzzystrmatch } from '@electric-sql/pglite/contrib/fuzzystrmatch';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import type { Rpc } from '../../supabase/functions/_shared/repo.ts';

/** Telefones fictícios, como o WhatsApp entrega (só dígitos). */
export const DEMO_PHONES = {
  carlos: '5531988887777', // pai, Família Souza: responde pela família
  marta: '5531977776666', // mãe, Família Souza
  bia: '5531966665555', // filha menor com telefone: só responde por si
  joao: '5521999990000', // tio, Família Barbosa
  desconhecido: '5511912345678', // fora da lista (pode se identificar pelo nome)
} as const;

export const DEMO_GUESTS = [
  { household: 'Família Souza', full_name: 'Carlos Souza', phone: '(31) 98888-7777', relationship: 'pai' },
  { household: 'Família Souza', full_name: 'Marta Souza', phone: '31 97777-6666', relationship: 'mãe' },
  { household: 'Família Souza', full_name: 'Pedro Souza', relationship: 'filho', is_minor: true },
  { household: 'Família Souza', full_name: 'Bia Souza', phone: '+55 31 96666-5555', relationship: 'filha', is_minor: true },
  { household: 'Família Barbosa', full_name: 'João Carlos Barbosa', phone: '21 99999-0000', relationship: 'tio' },
  { household: 'Família Barbosa', full_name: 'Joana Barbosa', relationship: 'tia' },
  { household: 'Vovó Lúcia', full_name: 'Lúcia Helena Dias', relationship: 'avó' },
];

const migrationsDir = join(process.cwd(), 'supabase', 'migrations');

export async function createDevDatabase(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pg_trgm, fuzzystrmatch } });
  // Papéis e privilégios padrão de todo projeto Supabase.
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  `);
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) await db.exec(readFileSync(join(migrationsDir, f), 'utf8'));
  return db;
}

/** Apaga tudo e importa os convidados fictícios. */
export async function resetDevData(db: PGlite, rpc: Rpc): Promise<void> {
  await db.exec(`
    truncate public.households, public.guests, public.rsvp_events, public.wa_contacts, public.bot_usage,
             public.gift_orders, public.gift_webhook_events cascade;
    update public.rsvp_settings
       set accepting_responses = true, deadline = null, turns_per_phone_per_day = 40, turns_per_day = 800
     where id = 1;
  `);
  const result = (await rpc('admin_import_guests', { p_rows: DEMO_GUESTS, p_apply: true })) as { errors: unknown[] };
  if (result.errors.length > 0) throw new Error(`Importação falhou: ${JSON.stringify(result.errors)}`);
}

/** Faz o tempo passar para as conversas abertas (a sessão esfria e vira resumo após 12 h). */
export async function passTime(db: PGlite, hours: number): Promise<void> {
  await db.query(
    `update public.wa_sessions
        set last_message_at = last_message_at - make_interval(hours => $1::int),
            started_at = started_at - make_interval(hours => $1::int)
      where closed_at is null`,
    [Math.round(hours)],
  );
}

// Tipos dos argumentos que não são texto (o PostgREST infere; aqui fazemos o cast).
const PARAM_TYPES: Record<string, string> = {
  p_targets: 'uuid[]',
  p_guest_id: 'uuid',
  p_for_guest_id: 'uuid',
  p_session_id: 'uuid',
  p_messages: 'jsonb',
  p_rows: 'jsonb',
  p_ids: 'bigint[]',
  p_summaries: 'integer',
  p_min_idle_minutes: 'integer',
  p_max_idle_minutes: 'integer',
  p_limit: 'integer',
  p_lease_seconds: 'integer',
  p_min_age_seconds: 'integer',
  p_audio_seconds: 'integer',
  p_new_turn: 'boolean',
  p_apply: 'boolean',
  p_id: 'bigint',
  p_approved: 'boolean',
  p_accept: 'boolean',
  p_order_id: 'uuid',
  p_base_cents: 'integer',
  p_charged_cents: 'integer',
  p_anonymous: 'boolean',
};

/** `Rpc` sobre o PGlite, executado como service_role (o papel das Edge Functions). */
export function pgliteRpc(db: PGlite): Rpc {
  return async (fn, args) => {
    if (!/^[a-z_]+$/.test(fn)) throw new Error(`Função inválida: ${fn}`);
    const names = Object.keys(args);
    const values = names.map((n) => (PARAM_TYPES[n] === 'jsonb' ? JSON.stringify(args[n]) : args[n]));
    const list = names.map((n, i) => `${n} => $${i + 1}::${PARAM_TYPES[n] ?? 'text'}`).join(', ');
    // Transação exclusiva: o papel não vaza para chamadas concorrentes.
    return db.transaction(async (tx) => {
      await tx.exec('set local role service_role');
      const { rows } = await tx.query<{ r: unknown }>(`select public.${fn}(${list}) as r`, values);
      return rows[0]?.r ?? null;
    });
  };
}
