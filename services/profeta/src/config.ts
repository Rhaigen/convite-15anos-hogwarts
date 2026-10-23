/**
 * Configuração do serviço do Profeta Diário, lida das variáveis de ambiente da stack
 * `convite-profeta` na VPS (ver docs/arquitetura.md#hospedagem → "Profeta Diário"). Nenhum valor
 * secreto tem padrão: sem eles o serviço nem sobe.
 */

export interface ProfetaConfig {
  port: number;
  /** Pasta do disco de tamanho fixo (edicao.json, midia/, tmp/). */
  dataDir: string;
  /** Palavra mágica impressa nos cartões das mesas (a Aifos também a conhece). */
  password: string;
  /** Assina o cookie de sessão (HMAC). */
  sessionSecret: string;
  /** Cabeçalho x-profeta-secret das rotas internas (whatsapp-webhook → serviço). */
  internalSecret: string;
  /** Teto de bytes guardados (fotos, vídeos, miniaturas e arquivos na fila). */
  quotaBytes: number;
  /** Espaço livre mínimo no disco; abaixo disso, recusa envios mesmo com cota sobrando. */
  reserveBytes: number;
  /** Janela de envio (a leitura continua depois de fechar). */
  opensAt: Date;
  closesAt: Date;
  evolution: { baseUrl: string; apiKey: string; instance: string } | null;
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function required(env: Record<string, string | undefined>, name: string, minLength = 1): string {
  const value = (env[name] ?? '').trim();
  if (value.length < minLength) {
    throw new Error(minLength > 1 ? `${name} ausente ou com menos de ${minLength} caracteres` : `${name} ausente`);
  }
  return value;
}

function date(env: Record<string, string | undefined>, name: string): Date {
  const value = required(env, name);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${name} não é uma data (use ISO, ex.: 2027-02-20T00:00:00-03:00)`);
  return parsed;
}

function positive(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = (env[name] ?? '').trim();
  if (!raw) return fallback;
  const value = Number(raw.replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} deve ser um número positivo`);
  return value;
}

export function readConfig(env: Record<string, string | undefined>): ProfetaConfig {
  const opensAt = date(env, 'PROFETA_ABRE_EM');
  const closesAt = date(env, 'PROFETA_FECHA_EM');
  if (closesAt <= opensAt) throw new Error('PROFETA_FECHA_EM deve ser depois de PROFETA_ABRE_EM');

  const evoUrl = (env.EVOLUTION_API_URL ?? '').trim();
  const evolution = evoUrl
    ? { baseUrl: evoUrl.replace(/\/+$/, ''), apiKey: required(env, 'EVOLUTION_API_KEY'), instance: required(env, 'EVOLUTION_INSTANCE') }
    : null;

  return {
    port: positive(env, 'PORT', 8080),
    dataDir: (env.PROFETA_DADOS ?? '/dados').trim(),
    password: required(env, 'PROFETA_SENHA', 4),
    sessionSecret: required(env, 'PROFETA_SESSAO_SEGREDO', 32),
    internalSecret: required(env, 'PROFETA_SECRET', 32),
    quotaBytes: Math.floor(positive(env, 'PROFETA_COTA_GB', 9) * GB),
    reserveBytes: Math.floor(positive(env, 'PROFETA_RESERVA_MB', 300) * MB),
    opensAt,
    closesAt,
    evolution,
  };
}
