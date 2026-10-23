/**
 * Lista de presentes: preços, validação e formatação (puro, sem APIs de navegador; também
 * usado pelo gerador do catálogo do servidor em scripts/lib/gift-catalog.ts).
 */
import type { FundGift, Gift, GiftsConfig, QuotaGift } from '../types/content.ts';
import { chargedCents, toBasisPoints, toCents, type FeeTable, type PaymentMethod } from './giftPricing.ts';

/** Limites do que o convidado escreve junto com o presente (os mesmos do banco). */
export const GIFT_MESSAGE_MAX = 500;
export const GIFT_SIGNATURE_MAX = 60;
/** Teto de um presente ou contribuição, em reais (o banco recusa acima disso). */
export const MAX_GIFT_REAIS = 100_000;

const GIFT_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
/** Foto do presente: só o nome do arquivo em presentes-originais/ (sem pastas). */
const GIFT_IMAGE = /^[\w-][\w.-]*\.(png|jpe?g|webp)$/i;

export function feeTableFrom(config: GiftsConfig): FeeTable {
  return {
    pixFixedCents: toCents(config.fees.pixFixed),
    cardFixedCents: toCents(config.fees.cardFixed),
    card: config.fees.card.map((b) => ({ upTo: b.upTo, basisPoints: toBasisPoints(b.percent) })),
  };
}

/** Total de cada forma de pagamento para a família receber `baseCents` (o que os botões mostram). */
export function chargePerMethod(baseCents: number, config: GiftsConfig): Record<PaymentMethod, number> {
  const fees = feeTableFrom(config);
  return {
    pix: chargedCents(baseCents, 'pix', fees, config.maxInstallments),
    card: chargedCents(baseCents, 'card', fees, config.maxInstallments),
  };
}

/** Valor real de uma cota (o que a família recebe), em centavos. */
export const quotaBaseCents = (gift: QuotaGift): number => toCents(gift.amount);

/** Valor digitado na vaquinha ("150", "150,50", "1.500,00") → centavos; `null` se inválido. */
export function parseReais(text: string): number | null {
  const clean = text.trim().replace(/^R\$\s*/i, '');
  if (!/^\d{1,3}(\.\d{3})*(,\d{1,2})?$|^\d+(,\d{1,2})?$/.test(clean)) return null;
  const [int, dec = ''] = clean.replace(/\./g, '').split(',');
  return Number(int) * 100 + Number(dec.padEnd(2, '0'));
}

/** Erro do valor da vaquinha (texto para a pessoa) ou `null` se estiver no intervalo. */
export function fundAmountError(amountCents: number | null, config: GiftsConfig): 'invalid' | 'min' | 'max' | null {
  if (amountCents === null || !Number.isInteger(amountCents)) return 'invalid';
  if (amountCents < toCents(config.fundMin)) return 'min';
  if (amountCents > toCents(config.fundMax)) return 'max';
  return null;
}

export function safeHttpsUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

const hasCents = (reais: number) => Number.isFinite(reais) && Math.abs(reais * 100 - Math.round(reais * 100)) < 1e-6;

/** Problemas na lista (vazio = tudo certo). Rodado pelos testes e pelo gerador do catálogo. */
export function validateGiftList(list: Gift[], config: GiftsConfig): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const gift of list) {
    const label = `"${gift.id}"`;
    if (!GIFT_ID.test(gift.id)) problems.push(`${label}: id deve ter só letras minúsculas, números e hífen (até 40)`);
    if (seen.has(gift.id)) problems.push(`${label}: id repetido`);
    seen.add(gift.id);
    if (!gift.name.trim() || gift.name.length > 80) problems.push(`${label}: nome vazio ou com mais de 80 caracteres`);
    if ((gift.description ?? '').length > 300) problems.push(`${label}: descrição com mais de 300 caracteres`);
    if (gift.image && !GIFT_IMAGE.test(gift.image)) problems.push(`${label}: foto deve ser só o nome do arquivo (.png, .jpg ou .webp)`);
    if (gift.kind === 'quota' && !(gift.amount > 0 && hasCents(gift.amount) && gift.amount <= MAX_GIFT_REAIS)) {
      problems.push(`${label}: valor inválido (${gift.amount})`);
    }
    if (gift.kind === 'fund' && !(gift.goal > 0 && hasCents(gift.goal))) problems.push(`${label}: meta inválida (${gift.goal})`);
    if (gift.kind === 'free' && gift.url && !safeHttpsUrl(gift.url)) problems.push(`${label}: link precisa ser https`);
  }
  if (!(config.fundMin > 0 && config.fundMax >= config.fundMin)) problems.push('giftsConfig: fundMin/fundMax inválidos');
  if (!(config.maxInstallments >= 1 && config.maxInstallments <= 21)) problems.push('giftsConfig: maxInstallments entre 1 e 21');
  return problems;
}

export const isQuota = (g: Gift): g is QuotaGift => g.kind === 'quota';
export const isFund = (g: Gift): g is FundGift => g.kind === 'fund';
