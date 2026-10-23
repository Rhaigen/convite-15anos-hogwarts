// CÓPIA GERADA de src/lib/giftPricing.ts por `npm run agent:facts`: não edite aqui.
/**
 * Preço dos presentes com os custos do Asaas embutidos (a taxa fica com o convidado).
 *
 * A família cadastra quanto quer RECEBER; o convidado escolhe no pergaminho entre Pix e
 * cartão, e cada botão mostra o total daquela forma (o checkout do Asaas só oferece a
 * forma escolhida). No Pix, a família recebe exatamente o valor da lista; no cartão, o
 * preço cobre a faixa das parcelas máximas (quem paga à vista deixa um pouco a mais).
 *
 * Tudo em centavos inteiros (sem erro de ponto flutuante). Arquivo PURO e sem imports:
 * `npm run agent:facts` copia este arquivo para supabase/functions/_shared/gifts/pricing.ts,
 * e o servidor recalcula o preço com o mesmo código (o que o navegador mandar é ignorado).
 */

export interface FeeTable {
  /** Tarifa fixa por Pix recebido, em centavos. */
  pixFixedCents: number;
  /** Tarifa fixa por cobrança no cartão, em centavos. */
  cardFixedCents: number;
  /** Faixas do cartão por número máximo de parcelas, em pontos-base (2,99% = 299). */
  card: { upTo: number; basisPoints: number }[];
}

/** Reais → centavos (aceita no máximo duas casas decimais). */
export function toCents(reais: number): number {
  return Math.round(reais * 100);
}

/** Percentual → pontos-base (2,99 → 299). */
export function toBasisPoints(percent: number): number {
  return Math.round(percent * 100);
}

/** Faixa do cartão que vale para até `maxInstallments` parcelas (a última, se passar de todas). */
export function cardBracket(fees: FeeTable, maxInstallments: number): { upTo: number; basisPoints: number } {
  const sorted = [...fees.card].sort((a, b) => a.upTo - b.upTo);
  const bracket = sorted.find((b) => maxInstallments <= b.upTo) ?? sorted[sorted.length - 1];
  if (!bracket) throw new Error('Tabela de taxas do cartão vazia');
  return bracket;
}

/** Quanto a família recebe de um pagamento de `chargedCents` no cartão (taxa arredondada para cima). */
export function cardNetCents(chargedCents: number, fees: FeeTable, maxInstallments: number): number {
  const { basisPoints } = cardBracket(fees, maxInstallments);
  return chargedCents - Math.ceil((chargedCents * basisPoints) / 10_000) - fees.cardFixedCents;
}

/** Quanto a família recebe de um Pix de `chargedCents`. */
export function pixNetCents(chargedCents: number, fees: FeeTable): number {
  return chargedCents - fees.pixFixedCents;
}

/** Forma de pagamento escolhida no pergaminho (cada uma vira um checkout só com ela). */
export type PaymentMethod = 'pix' | 'card';

export const PAYMENT_METHODS: readonly PaymentMethod[] = ['pix', 'card'];

/**
 * Preço cobrado para a família receber pelo menos `baseCents` na forma escolhida:
 * Pix = base + tarifa fixa; cartão = o suficiente na faixa de até `maxInstallments` parcelas.
 */
export function chargedCents(baseCents: number, method: PaymentMethod, fees: FeeTable, maxInstallments: number): number {
  if (!Number.isInteger(baseCents) || baseCents <= 0) throw new Error(`Valor inválido: ${baseCents}`);
  if (method === 'pix') return baseCents + fees.pixFixedCents;
  if (method !== 'card') throw new Error(`Forma de pagamento inválida: ${String(method)}`);
  const { basisPoints } = cardBracket(fees, maxInstallments);
  let price = Math.ceil(((baseCents + fees.cardFixedCents) * 10_000) / (10_000 - basisPoints));
  // A taxa do Asaas pode ser arredondada para cima: garante o líquido centavo a centavo.
  while (cardNetCents(price, fees, maxInstallments) < baseCents) price++;
  return price;
}

/** 15594 → "R$ 155,94" (sem depender do Intl do ambiente). */
export function formatBRL(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const reais = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const centavos = (abs % 100).toString().padStart(2, '0');
  return `${negative ? '-' : ''}R$ ${reais},${centavos}`;
}
