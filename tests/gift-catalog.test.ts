/**
 * O servidor confere os preços com uma cópia da lista de presentes (as Edge Functions não
 * importam de src/). Este teste falha se a cópia ficar desatualizada: rode `npm run agent:facts`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildGiftCatalog,
  CATALOG_PATH,
  clip,
  PRICING_PATH,
  renderGiftCatalogModule,
  renderPricingModule,
} from '../scripts/lib/gift-catalog.ts';
import { giftList } from '../src/content/gifts.ts';
import { giftsConfig } from '../src/content/settings.ts';
import { validateGiftList } from '../src/lib/gifts.ts';
import { GIFT_CATALOG, GIFT_IMAGE_BASE64 } from '../supabase/functions/_shared/gifts/catalog.ts';

const committed = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

describe('catálogo de presentes do servidor', () => {
  it('a lista do site não tem problemas', () => {
    expect(validateGiftList(giftList, giftsConfig)).toEqual([]);
  });

  it('catalog.ts está em dia com src/content (senão: npm run agent:facts)', () => {
    expect(committed(CATALOG_PATH)).toBe(renderGiftCatalogModule(GIFT_IMAGE_BASE64));
    expect(GIFT_CATALOG).toEqual(buildGiftCatalog());
  });

  it('pricing.ts do servidor é a mesma fórmula do site', () => {
    expect(committed(PRICING_PATH)).toBe(renderPricingModule());
  });

  it('a imagem dos itens é um PNG pequeno', () => {
    expect(Buffer.from(GIFT_IMAGE_BASE64, 'base64').subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(GIFT_IMAGE_BASE64.length).toBeLessThan(40_000);
  });

  it('nomes e descrições cabem nos limites do Asaas; foto só como caminho; sugestões livres ficam de fora', () => {
    const catalog = buildGiftCatalog(
      [
        { kind: 'quota', id: 'nimbus', name: 'Uma vassoura Nimbus 2000 para voar até a viagem', amount: 300, image: 'nimbus.jpg' },
        { kind: 'fund', id: 'viagem', name: 'Viagem', description: 'x'.repeat(200), goal: 5000 },
        { kind: 'free', id: 'livros', name: 'Livros' },
      ],
      giftsConfig,
    );
    expect(catalog.gifts.map((g) => g.id)).toEqual(['nimbus', 'viagem']);
    expect(catalog.gifts[0]).toMatchObject({ kind: 'quota', amountCents: 30_000, checkoutName: 'Uma vassoura Nimbus 2000 para…', photo: '/presentes/nimbus.png' });
    expect(catalog.gifts[1]).not.toHaveProperty('photo');
    expect(catalog.gifts[0]!.checkoutName.length).toBe(30);
    expect(catalog.gifts[0]!.checkoutDescription).toBe('Presente para os 15 anos de Sofia');
    expect(catalog.gifts[1]).toMatchObject({ kind: 'fund', goalCents: 500_000 });
    expect(catalog.gifts[1]!.checkoutDescription.length).toBe(150);
    expect(clip('  a   b  ', 30)).toBe('a b');
  });

  it('lista com problema não gera catálogo', () => {
    expect(() => buildGiftCatalog([{ kind: 'quota', id: 'x', name: 'X', amount: -1 }], giftsConfig)).toThrow(/valor inválido/);
  });
});
