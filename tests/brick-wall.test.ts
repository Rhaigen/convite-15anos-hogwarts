import { describe, expect, it } from 'vitest';
import { archHalfWidthAt, buildWallLayout, createRandom, insideArch } from '../src/lib/brickWall';

const VIEWPORTS = [
  [1440, 900],
  [1920, 1080],
  [390, 844],
  [844, 390],
  [320, 640],
] as const;

describe('parede do Beco Diagonal', () => {
  it('é determinística', () => {
    const a = buildWallLayout(1440, 900);
    const b = buildWallLayout(1440, 900);
    expect(a).toEqual(b);
    expect(createRandom(5)()).toBe(createRandom(5)());
  });

  for (const [w, h] of VIEWPORTS) {
    it(`cobre a tela e mantém o arco visível em ${w}×${h}`, () => {
      const layout = buildWallLayout(w, h, w < 768 ? 6 : 8);
      const { arch, cells } = layout;
      // Arco inteiro dentro da tela.
      expect(arch.topY).toBeGreaterThanOrEqual(0);
      expect(arch.cx - arch.halfWidth).toBeGreaterThanOrEqual(0);
      expect(arch.cx + arch.halfWidth).toBeLessThanOrEqual(w);
      expect(arch.bottomY).toBe(layout.groundY);
      // Tijolos cobrem toda a largura e a altura acima do chão, sem buracos entre células.
      expect(Math.min(...cells.map((c) => c.x))).toBeLessThanOrEqual(0);
      expect(Math.max(...cells.map((c) => c.x + c.w))).toBeGreaterThanOrEqual(w);
      expect(Math.min(...cells.map((c) => c.y))).toBeLessThanOrEqual(0);
      for (const row of new Set(cells.map((c) => c.row))) {
        const inRow = cells.filter((c) => c.row === row).sort((p, q) => p.x - q.x);
        inRow.slice(1).forEach((c, i) => expect(c.x).toBe(inRow[i]!.x + inRow[i]!.w));
      }
      // Quantidade de tijolos animados razoável para o aparelho.
      const moving = cells.filter((c) => c.inArch);
      expect(moving.length).toBeGreaterThan(40);
      expect(moving.length).toBeLessThan(320);
    });
  }

  it('abre a partir do tijolo tocado pela varinha', () => {
    const layout = buildWallLayout(1440, 900);
    const key = layout.cells[layout.keyIndex]!;
    expect(key.inArch).toBe(true);
    expect(key.order).toBe(0);
    const moving = layout.cells.filter((c) => c.inArch);
    for (const c of moving) {
      expect(c.order).toBeGreaterThanOrEqual(0);
      expect(c.order).toBeLessThanOrEqual(1);
      expect(insideArch(layout.arch, c.x + c.w / 2, c.y + c.h / 2)).toBe(true);
    }
    expect(Math.max(...moving.map((c) => c.order))).toBe(1);
    // Tijolos fora do arco nunca se movem.
    expect(layout.cells.filter((c) => !c.inArch).every((c) => c.order === 0)).toBe(true);
  });

  it('o vão é reto embaixo e semicircular em cima', () => {
    const { arch } = buildWallLayout(1440, 900);
    expect(archHalfWidthAt(arch, arch.bottomY - 1)).toBe(arch.halfWidth);
    expect(archHalfWidthAt(arch, arch.springY)).toBe(arch.halfWidth);
    expect(archHalfWidthAt(arch, arch.topY + 0.001)).toBeLessThan(arch.halfWidth * 0.1);
    expect(archHalfWidthAt(arch, arch.topY - 1)).toBe(0);
    expect(archHalfWidthAt(arch, arch.bottomY + 1)).toBe(0);
  });
});
