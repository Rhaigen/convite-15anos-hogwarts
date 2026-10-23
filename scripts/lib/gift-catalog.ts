/**
 * Catálogo da lista de presentes para as Edge Functions (que não importam arquivos de
 * fora de supabase/functions). Gerado junto com os fatos da Aifos por `npm run agent:facts`:
 *   supabase/functions/_shared/gifts/catalog.ts  ← src/content/gifts.ts + settings.ts
 *   supabase/functions/_shared/gifts/pricing.ts  ← cópia de src/lib/giftPricing.ts
 * tests/gift-catalog.test.ts falha se algum dos dois ficar desatualizado.
 */
import { readFileSync } from 'node:fs';
import { event } from '../../src/content/event.ts';
import { giftList } from '../../src/content/gifts.ts';
import { giftsConfig } from '../../src/content/settings.ts';
import { toCents } from '../../src/lib/giftPricing.ts';
import { feeTableFrom, validateGiftList } from '../../src/lib/gifts.ts';
import type { CatalogGift, GiftCatalog } from '../../supabase/functions/_shared/gifts/catalogTypes.ts';
import type { Gift, GiftsConfig } from '../../src/types/content.ts';

export const CATALOG_PATH = 'supabase/functions/_shared/gifts/catalog.ts';
export const PRICING_PATH = 'supabase/functions/_shared/gifts/pricing.ts';

/** Onde `npm run gifts:images` põe o PNG do item do checkout (public/presentes/<id>.png). */
export const giftPhotoPath = (id: string) => `/presentes/${id}.png`;
export const PRICING_SOURCE = 'src/lib/giftPricing.ts';

/** Corta no limite do Asaas, terminando em reticências. */
export function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

export function buildGiftCatalog(list: Gift[] = giftList, config: GiftsConfig = giftsConfig): GiftCatalog {
  const problems = validateGiftList(list, config);
  if (problems.length > 0) throw new Error(`Lista de presentes com problemas:\n- ${problems.join('\n- ')}`);
  const fallback = `Presente para os 15 anos de ${event.celebrantFirstName}`;
  const gifts = list.flatMap((g): CatalogGift[] => {
    const base = {
      id: g.id,
      name: g.name,
      checkoutName: clip(g.name, 30),
      checkoutDescription: clip(g.description || fallback, 150),
      ...(g.image ? { photo: giftPhotoPath(g.id) } : {}),
    };
    if (g.kind === 'quota') return [{ ...base, kind: 'quota', amountCents: toCents(g.amount) }];
    if (g.kind === 'fund') return [{ ...base, kind: 'fund', goalCents: toCents(g.goal) }];
    return [];
  });
  return {
    maxInstallments: config.maxInstallments,
    fees: feeTableFrom(config),
    fundMinCents: toCents(config.fundMin),
    fundMaxCents: toCents(config.fundMax),
    gifts,
  };
}

/** Conteúdo de supabase/functions/_shared/gifts/catalog.ts (`imageBase64`: PNG do brasão). */
export function renderGiftCatalogModule(imageBase64: string, catalog: GiftCatalog = buildGiftCatalog()): string {
  return `/**
 * Catálogo da lista de presentes para as Edge Functions (preços conferidos no servidor).
 * GERADO por \`npm run agent:facts\` a partir de src/content/gifts.ts e settings.ts: não edite à mão.
 * tests/gift-catalog.test.ts falha se este arquivo ficar desatualizado.
 */
import type { GiftCatalog } from './catalogTypes.ts';

export const GIFT_CATALOG: GiftCatalog = ${JSON.stringify(catalog, null, 2)};

/** Imagem dos itens no checkout do Asaas (obrigatória): o brasão da Sofia, PNG pequeno. */
export const GIFT_IMAGE_BASE64 =
  ${JSON.stringify(imageBase64)};
`;
}

/** Conteúdo de supabase/functions/_shared/gifts/pricing.ts: a mesma fórmula do site. */
export function renderPricingModule(source = readFileSync(PRICING_SOURCE, 'utf8')): string {
  const body = source.replace(/\r\n/g, '\n');
  return `// CÓPIA GERADA de ${PRICING_SOURCE} por \`npm run agent:facts\`: não edite aqui.\n${body}`;
}
