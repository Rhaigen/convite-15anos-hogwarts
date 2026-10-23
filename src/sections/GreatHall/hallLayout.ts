/**
 * Geometria do Salão Principal (pura, testada em tests/hall-layout.test.ts).
 *
 * As cartas ficam numa grade com variação: colunas ímpares descem meia fileira e cada
 * carta ganha um pequeno desvio, inclinação, profundidade e ritmo de flutuação. Tudo
 * vem de um sorteio determinístico PELO ÍNDICE: uma carta nova entra no fim sem
 * embaralhar as que já estavam penduradas.
 *
 * Unidades: x em fração da largura do campo (centro da carta); y em fileiras (topo da carta).
 */

/** Profundidade: 0 = ao fundo (menor, mais lenta), 2 = à frente. */
export type Depth = 0 | 1 | 2;

export interface HallSlot {
  x: number;
  y: number;
  /** Inclinação de repouso (graus). */
  rotate: number;
  depth: Depth;
  /** Fase da flutuação (0–1), vira atraso negativo da animação. */
  phase: number;
  /** Duração de um ciclo de flutuação (s). */
  duration: number;
}

export interface HallLayout {
  slots: HallSlot[];
  /** Altura do campo, em fileiras. */
  rows: number;
}

/** Desvio máximo, em fração da coluna (x) e da fileira (y). */
export const JITTER_X = 0.08;
export const JITTER_Y = 0.07;
/** Altura que uma carta (vela + fio + envelope) ocupa, em fileiras: menor que 1 − 2·JITTER_Y. */
export const LETTER_ROWS = 0.84;

/** Colunas de ~150 px pela largura do campo (3 no celular, até 7 no desktop). A carta ocupa até 72% da coluna (CSS `--lw`). */
export function hallColumns(width: number): number {
  return Math.min(7, Math.max(3, Math.floor(width / 150)));
}

/** Sorteio determinístico (mulberry32) a partir de uma semente inteira. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function layoutHall(count: number, columns: number): HallLayout {
  const cols = Math.max(1, Math.floor(columns));
  const stagger = cols > 1 ? 0.5 : 0;
  const slots: HallSlot[] = [];
  for (let i = 0; i < count; i++) {
    const rnd = random(Math.imul(i + 1, 2654435761));
    const col = i % cols;
    const row = Math.floor(i / cols);
    const jx = rnd() * 2 - 1;
    const jy = rnd() * 2 - 1;
    const d = rnd();
    slots.push({
      x: (col + 0.5 + jx * JITTER_X) / cols,
      y: JITTER_Y + row + (col % 2 === 1 ? stagger : 0) + jy * JITTER_Y,
      rotate: Math.round((rnd() * 2 - 1) * 70) / 10,
      depth: d < 0.22 ? 0 : d < 0.78 ? 1 : 2,
      phase: rnd(),
      duration: 5 + rnd() * 3,
    });
  }
  const lastRow = count === 0 ? 0 : Math.max(...slots.map((s) => s.y));
  return { slots, rows: count === 0 ? 0 : lastRow + LETTER_ROWS + JITTER_Y };
}
