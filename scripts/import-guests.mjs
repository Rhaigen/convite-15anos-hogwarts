/**
 * Importa a planilha de convidados para o Supabase.
 *
 *   npm run guests:import -- convidados.csv           # simula: valida e mostra o resumo
 *   npm run guests:import -- convidados.csv --apply   # grava
 *
 * Modelo: docs/convidados-modelo.csv. Credenciais em .env.local (não versionado):
 *   SUPABASE_URL=https://<ref>.supabase.co
 *   SUPABASE_SECRET_KEY=sb_secret_...   (ou a service_role legada)
 *
 * A validação e a gravação acontecem no banco (public.admin_import_guests), numa
 * única transação: com qualquer erro, nada é gravado. Reimportar atualiza os dados
 * de cada pessoa (família pelo nome, convidado pelo nome) e nunca apaga respostas
 * nem convidados que saíram da planilha (eles aparecem nos avisos).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { parseGuestsCsv } from './lib/guests-csv.mjs';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const file = args.find((a) => !a.startsWith('--'));

if (!file) {
  console.error('Uso: npm run guests:import -- <planilha.csv> [--apply]');
  process.exit(1);
}

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Defina SUPABASE_URL e SUPABASE_SECRET_KEY em .env.local (veja .env.example).');
  process.exit(1);
}

const { rows, errors: csvErrors } = parseGuestsCsv(readFileSync(resolve(file), 'utf8'));
if (csvErrors.length) {
  console.error('Planilha com problemas de formato:');
  for (const e of csvErrors) console.error(`  ✗ ${e}`);
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const { data, error } = await supabase.rpc('admin_import_guests', { p_rows: rows, p_apply: apply });
if (error) {
  console.error(`Erro do Supabase: ${error.message}`);
  process.exit(1);
}

console.log(`${data.rows} convidados em ${data.households} famílias.`);
for (const e of data.errors) console.log(`  ✗ ${e}`);
for (const w of data.warnings) console.log(`  ! ${w}`);

if (!data.ok) {
  console.log('\nNada foi gravado. Corrija a planilha e rode de novo.');
  process.exit(1);
}
if (data.applied) {
  console.log(`\nGravado: ${data.inserted} novos, ${data.updated} atualizados.`);
} else {
  console.log('\nSimulação OK. Para gravar, rode de novo com --apply.');
}
