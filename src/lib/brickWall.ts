/**
 * Geometria da parede de tijolos que dá acesso ao Beco Diagonal (Capítulo I).
 * Funções puras (sem APIs de navegador) para poderem ser testadas.
 *
 * A parede é um aparelho "meia-vez" (cada fiada deslocada meio tijolo). As
 * células cujo centro fica dentro do arco são os tijolos que se movem; as
 * demais são pintadas uma única vez num canvas estático.
 */

export interface BrickCell {
  index: number;
  row: number;
  /** Retângulo da célula (tijolo + meia junta de argamassa em volta), em px inteiros. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Faz parte da passagem que se abre. */
  inArch: boolean;
  /** 0–1: momento relativo em que o tijolo sai do lugar (0 = tijolo tocado pela varinha). */
  order: number;
  /** Lado para onde o tijolo desliza ao abrir. */
  side: -1 | 1;
  /** Semente determinística para cor, textura e movimento. */
  seed: number;
}

export interface Arch {
  cx: number;
  halfWidth: number;
  /** Linha de nascença: abaixo dela o vão é reto; acima, semicircular. */
  springY: number;
  topY: number;
  bottomY: number;
}

export interface WallLayout {
  width: number;
  height: number;
  /** Linha do chão do pátio (base da parede e do arco). */
  groundY: number;
  cellW: number;
  courseH: number;
  mortar: number;
  arch: Arch;
  /** Altura do ponto de fuga (altura dos olhos) usada pela perspectiva e pelo beco. */
  vanishY: number;
  cells: BrickCell[];
  /** Índice (em `cells`) do tijolo tocado pela varinha. */
  keyIndex: number;
}

/** Gerador pseudoaleatório determinístico (mulberry32). */
export function createRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Meia largura do vão na altura `y` (0 fora do arco). */
export function archHalfWidthAt(arch: Arch, y: number): number {
  if (y > arch.bottomY || y < arch.topY) return 0;
  if (y >= arch.springY) return arch.halfWidth;
  const dy = arch.springY - y;
  return Math.sqrt(Math.max(0, arch.halfWidth * arch.halfWidth - dy * dy));
}

export function insideArch(arch: Arch, x: number, y: number): boolean {
  return Math.abs(x - arch.cx) < archHalfWidthAt(arch, y);
}

/**
 * Monta a parede para uma área de `width × height` px.
 * `bricksAcross` controla quantos tijolos cabem na largura do arco
 * (menos tijolos = menos elementos animados em aparelhos modestos).
 */
export function buildWallLayout(width: number, height: number, bricksAcross = 8, seed = 2027): WallLayout {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const groundY = Math.round(h * 0.9);

  const halfWidth = Math.min(w * 0.36, h * 0.3);
  const archH = Math.min(groundY - h * 0.1, halfWidth * 2 * 1.55);
  const arch: Arch = {
    cx: w / 2,
    halfWidth,
    springY: groundY - (archH - halfWidth),
    topY: groundY - archH,
    bottomY: groundY,
  };

  // Proporção de um tijolo comum com junta (22,5 × 7,5 cm ≈ 3 : 1).
  const cellW = (halfWidth * 2) / bricksAcross;
  const courseH = cellW / 3;
  const mortar = Math.max(1.5, courseH * 0.13);

  const rand = createRandom(seed);
  const cells: BrickCell[] = [];
  const rows = Math.ceil(groundY / courseH) + 1;

  for (let row = 0; row < rows; row++) {
    const yBottom = Math.round(groundY - row * courseH);
    const yTop = Math.round(groundY - (row + 1) * courseH);
    if (yBottom <= 0) break;
    // Juntas verticais alinhadas ao eixo do arco nas fiadas pares; deslocadas nas ímpares.
    const offset = row % 2 === 0 ? 0 : cellW / 2;
    const kStart = Math.floor((0 - arch.cx - offset) / cellW) - 1;
    const kEnd = Math.ceil((w - arch.cx - offset) / cellW) + 1;
    for (let k = kStart; k < kEnd; k++) {
      const x0 = Math.round(arch.cx + offset + k * cellW);
      const x1 = Math.round(arch.cx + offset + (k + 1) * cellW);
      if (x1 <= 0 || x0 >= w) continue;
      const centerX = (x0 + x1) / 2;
      const centerY = (yTop + yBottom) / 2;
      cells.push({
        index: cells.length,
        row,
        x: x0,
        y: yTop,
        w: x1 - x0,
        h: yBottom - yTop,
        inArch: insideArch(arch, centerX, centerY),
        order: 0,
        side: centerX >= arch.cx ? 1 : -1,
        seed: Math.floor(rand() * 2 ** 31),
      });
    }
  }

  // Tijolo tocado pela varinha: o mais próximo do centro do vão, na altura dos olhos.
  const vanishY = groundY - archH * 0.5;
  const keyX = arch.cx + cellW * 0.5;
  const keyY = groundY - archH * 0.45;
  const archCells = cells.filter((c) => c.inArch);
  let keyIndex = archCells[0]?.index ?? 0;
  let best = Infinity;
  for (const c of archCells) {
    const d = Math.hypot(c.x + c.w / 2 - keyX, c.y + c.h / 2 - keyY);
    if (d < best) {
      best = d;
      keyIndex = c.index;
    }
  }

  // A abertura se propaga do tijolo tocado para fora, com leve irregularidade.
  const key = cells[keyIndex];
  if (key) {
    const kx = key.x + key.w / 2;
    const ky = key.y + key.h / 2;
    let max = 0;
    const raw = new Map<number, number>();
    for (const c of archCells) {
      const r = createRandom(c.seed)();
      const dx = (c.x + c.w / 2 - kx) / halfWidth;
      const dy = (c.y + c.h / 2 - ky) / (archH * 0.62);
      const d = c.index === keyIndex ? 0 : Math.hypot(dx, dy) + 0.06 + r * 0.14;
      raw.set(c.index, d);
      max = Math.max(max, d);
    }
    for (const c of archCells) c.order = max > 0 ? (raw.get(c.index) ?? 0) / max : 0;
    // Tijolos no eixo central escolhem o lado de forma alternada.
    for (const c of archCells) {
      if (Math.abs(c.x + c.w / 2 - arch.cx) < cellW * 0.3) c.side = c.row % 2 === 0 ? 1 : -1;
    }
  }

  return { width: w, height: h, groundY, cellW, courseH, mortar, arch, vanishY, cells, keyIndex };
}
