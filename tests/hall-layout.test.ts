/**
 * O Salão Principal: geometria das cartas (sem sobreposição, determinística, estável
 * quando chegam cartas novas) e leitura da resposta da função site-messages.
 */
import { describe, expect, it } from 'vitest';
import { hallColumns, JITTER_X, LETTER_ROWS, layoutHall } from '../src/sections/GreatHall/hallLayout';
import { MAX_LETTERS, parseDemoParam, parseWall } from '../src/lib/messageWall';

/** Largura da carta em fração da coluna (CSS: --lw ≤ 72% de --colw). */
const LETTER_COL = 0.72;

describe('layoutHall', () => {
  it.each([3, 4, 5, 6, 7])('%i colunas: nenhuma carta encosta em outra e todas cabem no campo', (cols) => {
    const { slots, rows } = layoutHall(60, cols);
    const colW = 1 / cols;
    for (const s of slots) {
      expect(s.x - (LETTER_COL * colW) / 2).toBeGreaterThanOrEqual(0);
      expect(s.x + (LETTER_COL * colW) / 2).toBeLessThanOrEqual(1);
      expect(s.y).toBeGreaterThanOrEqual(0);
      expect(s.y + LETTER_ROWS).toBeLessThanOrEqual(rows + 1e-9);
    }
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        const a = slots[i]!;
        const b = slots[j]!;
        const apartX = Math.abs(a.x - b.x) >= LETTER_COL * colW;
        const apartY = Math.abs(a.y - b.y) >= LETTER_ROWS;
        expect(apartX || apartY, `${i} × ${j}`).toBe(true);
      }
    }
  });

  it('é determinística e não embaralha as cartas já penduradas quando chega uma nova', () => {
    expect(layoutHall(12, 4)).toEqual(layoutHall(12, 4));
    expect(layoutHall(13, 4).slots.slice(0, 12)).toEqual(layoutHall(12, 4).slots);
  });

  it('varia inclinação, profundidade e ritmo dentro dos limites', () => {
    const { slots } = layoutHall(200, 7);
    expect(new Set(slots.map((s) => s.depth))).toEqual(new Set([0, 1, 2]));
    for (const s of slots) {
      expect(Math.abs(s.rotate)).toBeLessThanOrEqual(7);
      expect(s.duration).toBeGreaterThanOrEqual(5);
      expect(s.duration).toBeLessThanOrEqual(8);
      expect(s.phase).toBeGreaterThanOrEqual(0);
      expect(s.phase).toBeLessThan(1);
    }
    expect(JITTER_X).toBeLessThan((1 - LETTER_COL) / 2);
  });

  it('sem cartas, sem altura; colunas pela largura do campo', () => {
    expect(layoutHall(0, 4)).toEqual({ slots: [], rows: 0 });
    expect([320, 358, 640, 768, 1152, 1600].map(hallColumns)).toEqual([3, 3, 4, 5, 7, 7]);
  });
});

describe('parseDemoParam (demonstração no npm run dev)', () => {
  it('aceita hífen, travessão do teclado do celular, espaço e maiúsculas', () => {
    for (const p of ['selado-80', 'selado–80', 'selado—80', 'Selado 80', 'selado80']) {
      expect(parseDemoParam(p), p).toEqual({ state: 'selado', amount: 80 });
    }
    expect(parseDemoParam('aberto–80')).toEqual({ state: 'aberto', amount: 80 });
    expect(parseDemoParam('vazio')).toEqual({ state: 'vazio', amount: null });
    expect(parseDemoParam('aberto')).toEqual({ state: 'aberto', amount: null });
    expect(parseDemoParam('qualquer')).toEqual({ state: 'selado', amount: null });
  });
});

describe('parseWall', () => {
  it('selada: guarda só id e remetente, mesmo se o texto vier', () => {
    expect(
      parseWall({ sealed: true, unsealAt: '2027-02-20T03:00:00+00:00', letters: [{ id: 'a', from: ' Tio Carlos ', body: 'segredo' }] }),
    ).toEqual({ sealed: true, unsealAt: new Date('2027-02-20T03:00:00Z'), letters: [{ id: 'a', from: 'Tio Carlos' }] });
  });

  it('aberta: descarta cartas sem texto, ids repetidos e itens fora do formato', () => {
    const wall = parseWall({
      sealed: false,
      unsealAt: 'não é data',
      letters: [
        { id: 'a', from: 'Ana', body: 'Oi' },
        { id: 'a', from: 'Ana de novo', body: 'Repetida' },
        { id: 'b', from: 'Bruno' },
        { id: 'c', from: '   ', body: 'Sem nome' },
        { id: 7, from: 'Número', body: 'x' },
        null,
      ],
    });
    expect(wall).toEqual({ sealed: false, unsealAt: null, letters: [{ id: 'a', from: 'Ana', body: 'Oi' }] });
  });

  it('formato inválido vira null; na dúvida, selada; respeita o teto', () => {
    expect(parseWall(null)).toBeNull();
    expect(parseWall({ letters: 'x' })).toBeNull();
    expect(parseWall({ letters: [{ id: 'a', from: 'Ana', body: 'Oi' }] })?.letters).toEqual([{ id: 'a', from: 'Ana' }]);
    const many = Array.from({ length: MAX_LETTERS + 20 }, (_, i) => ({ id: `id${i}`, from: 'X' }));
    expect(parseWall({ sealed: true, letters: many })?.letters).toHaveLength(MAX_LETTERS);
  });
});
