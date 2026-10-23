/**
 * Lista de presentes: cada botão (Pix / cartão) mostra o total com os custos do Asaas
 * daquela forma (a taxa fica com o convidado) e a família recebe pelo menos o valor da lista.
 */
import { describe, expect, it } from 'vitest';
import { giftsConfig } from '../src/content/settings.ts';
import {
  cardBracket,
  cardNetCents,
  chargedCents,
  formatBRL,
  pixNetCents,
  toBasisPoints,
  toCents,
  type FeeTable,
} from '../src/lib/giftPricing.ts';
import { chargePerMethod, feeTableFrom, fundAmountError, parseReais, quotaBaseCents, validateGiftList } from '../src/lib/gifts.ts';
import type { Gift, GiftsConfig } from '../src/types/content.ts';

const FEES: FeeTable = {
  pixFixedCents: 199,
  cardFixedCents: 49,
  card: [
    { upTo: 1, basisPoints: 299 },
    { upTo: 6, basisPoints: 349 },
    { upTo: 12, basisPoints: 399 },
    { upTo: 21, basisPoints: 429 },
  ],
};

describe('preço com os custos do Asaas', () => {
  it('R$ 290 (o exemplo do plano): Pix R$ 291,99 e cartão em até 6x R$ 301,00', () => {
    const pix = chargedCents(29_000, 'pix', FEES, 6);
    const card = chargedCents(29_000, 'card', FEES, 6);
    expect(formatBRL(pix)).toBe('R$ 291,99');
    expect(formatBRL(card)).toBe('R$ 301,00');
    expect(pixNetCents(pix, FEES)).toBe(29_000);
    expect(cardNetCents(card, FEES, 6)).toBeGreaterThanOrEqual(29_000);
  });

  it('R$ 150: no Pix a família recebe exatamente a base; no cartão em até 6x também', () => {
    expect(chargedCents(15_000, 'pix', FEES, 6)).toBe(15_199);
    const card = chargedCents(15_000, 'card', FEES, 6);
    expect(card).toBe(15_594);
    expect(cardNetCents(card, FEES, 6)).toBe(15_000);
  });

  it('cartão: mais parcelas, preço maior; o Pix não depende das parcelas', () => {
    expect(chargedCents(15_000, 'card', FEES, 1)).toBeLessThan(chargedCents(15_000, 'card', FEES, 6));
    expect(chargedCents(15_000, 'card', FEES, 6)).toBeLessThan(chargedCents(15_000, 'card', FEES, 12));
    expect(chargedCents(15_000, 'pix', FEES, 1)).toBe(chargedCents(15_000, 'pix', FEES, 12));
    expect(cardBracket(FEES, 7).upTo).toBe(12);
    expect(cardBracket(FEES, 99).upTo).toBe(21);
  });

  it('em valores pequenos o cartão sai mais barato que o Pix (tarifa fixa)', () => {
    expect(chargedCents(2_000, 'pix', FEES, 6)).toBe(2_199);
    expect(chargedCents(2_000, 'card', FEES, 6)).toBeLessThan(2_199);
  });

  it('nunca deixa a família com menos do que a base, nem cobra um centavo a mais (varredura)', () => {
    for (let base = 500; base <= 500_000; base += 137) {
      const pix = chargedCents(base, 'pix', FEES, 6);
      expect(pixNetCents(pix, FEES)).toBe(base);
      for (const max of [1, 6, 12]) {
        const card = chargedCents(base, 'card', FEES, max);
        expect(cardNetCents(card, FEES, max)).toBeGreaterThanOrEqual(base);
        expect(cardNetCents(card - 1, FEES, max)).toBeLessThan(base);
      }
    }
  });

  it('recusa valor ou forma de pagamento inválidos', () => {
    expect(() => chargedCents(0, 'pix', FEES, 6)).toThrow();
    expect(() => chargedCents(10.5, 'card', FEES, 6)).toThrow();
    expect(() => chargedCents(1_000, 'boleto' as never, FEES, 6)).toThrow();
  });

  it('conversões e formatação', () => {
    expect(toCents(1.99)).toBe(199);
    expect(toCents(0.29 + 0.01)).toBe(30);
    expect(toBasisPoints(3.49)).toBe(349);
    expect(formatBRL(123_456_789)).toBe('R$ 1.234.567,89');
    expect(formatBRL(5)).toBe('R$ 0,05');
  });

  it('a configuração do site gera a tabela em centavos', () => {
    expect(feeTableFrom(giftsConfig)).toEqual(FEES);
    expect(giftsConfig.maxInstallments).toBe(6);
  });
});

describe('cotas e vaquinhas', () => {
  it('a cota mostra o valor real; os botões, o total de cada forma', () => {
    const varinha = { kind: 'quota', id: 'varinha', name: 'Varinha', amount: 150 } as const;
    expect(quotaBaseCents(varinha)).toBe(15_000);
    expect(chargePerMethod(quotaBaseCents(varinha), giftsConfig)).toEqual({ pix: 15_199, card: 15_594 });
    expect(chargePerMethod(10_000, giftsConfig)).toEqual({
      pix: chargedCents(10_000, 'pix', FEES, 6),
      card: chargedCents(10_000, 'card', FEES, 6),
    });
  });

  it('lê o valor digitado em reais', () => {
    expect(parseReais('150')).toBe(15_000);
    expect(parseReais('150,5')).toBe(15_050);
    expect(parseReais(' R$ 1.500,00 ')).toBe(150_000);
    expect(parseReais('1500,99')).toBe(150_099);
    for (const bad of ['', 'abc', '150.5', '1,999', '-10', '1.50,00', '10,']) expect(parseReais(bad)).toBeNull();
  });

  it('limites da vaquinha', () => {
    expect(fundAmountError(null, giftsConfig)).toBe('invalid');
    expect(fundAmountError(1_999, giftsConfig)).toBe('min');
    expect(fundAmountError(2_000, giftsConfig)).toBeNull();
    expect(fundAmountError(500_001, giftsConfig)).toBe('max');
  });
});

describe('validação da lista', () => {
  const config: GiftsConfig = giftsConfig;
  it('aceita os três tipos', () => {
    const list: Gift[] = [
      { kind: 'quota', id: 'varinha', name: 'Uma varinha nova', amount: 150 },
      { kind: 'fund', id: 'viagem-2027', name: 'A viagem', goal: 5000 },
      { kind: 'free', id: 'livros', name: 'Livros', url: 'https://loja.example/livro' },
    ];
    expect(validateGiftList(list, config)).toEqual([]);
  });

  it('foto: só o nome do arquivo em presentes-originais/ (sem pastas)', () => {
    const quota = (image: string): Gift => ({ kind: 'quota', id: 'fone', name: 'Fone', amount: 100, image });
    expect(validateGiftList([quota('fone-qcy-HT08-pro.png')], config)).toEqual([]);
    for (const bad of ['../segredo.png', 'pasta/fone.png', 'fone.gif', '.png']) {
      expect(validateGiftList([quota(bad)], config).join()).toMatch(/foto/);
    }
  });

  it('acusa id inválido ou repetido, valor sem centavos exatos e link sem https', () => {
    const problems = validateGiftList(
      [
        { kind: 'quota', id: 'Varinha Nova', name: 'A', amount: 10 },
        { kind: 'quota', id: 'a', name: 'B', amount: 10.555 },
        { kind: 'fund', id: 'a', name: 'C', goal: 0 },
        { kind: 'free', id: 'd', name: 'D', url: 'http://loja.example' },
      ],
      config,
    );
    expect(problems).toHaveLength(5);
    expect(problems.join('\n')).toMatch(/Varinha Nova.*id/);
    expect(problems.join('\n')).toMatch(/"a": id repetido/);
    expect(problems.join('\n')).toMatch(/https/);
  });
});
