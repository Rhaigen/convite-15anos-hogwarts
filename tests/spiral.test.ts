import { describe, expect, it } from 'vitest';
import { FADE_END, focusAt, framePose, progressFor, towerMetrics } from '../src/sections/SofiaGallery/spiral';

const VIEWPORTS = [
  [1440, 900],
  [390, 844],
  [844, 390],
  [320, 640],
] as const;

describe('torre espiral de retratos', () => {
  const m = towerMetrics(1440, 900);

  it('o quadro em foco fica na frente, sem giro nem sombra', () => {
    for (const f of [0, 3, 7.25]) {
      const pose = framePose(f, f, m);
      expect(pose.x).toBeCloseTo(0);
      expect(pose.y).toBeCloseTo(0);
      expect(pose.z).toBeCloseTo(0);
      expect(pose.rotY).toBeCloseTo(0);
      expect(pose.shade).toBeCloseTo(0);
      expect(pose.opacity).toBe(1);
      expect(pose.front).toBe(true);
    }
  });

  it('dois quadros adiante fica atrás do eixo, totalmente na sombra', () => {
    const pose = framePose(2, 0, m);
    expect(pose.x).toBeCloseTo(0);
    expect(pose.z).toBeCloseTo(-2 * m.radius);
    expect(pose.shade).toBeCloseTo(1);
    expect(pose.front).toBe(false);
    // O verso fica voltado para quem olha.
    expect(pose.rotY).toBeCloseTo(180);
  });

  it('os quadros vizinhos ficam dos lados, com a frente ainda visível', () => {
    const next = framePose(1, 0, m);
    const prev = framePose(-1, 0, m);
    expect(next.x).toBeCloseTo(m.radius);
    expect(prev.x).toBeCloseTo(-m.radius);
    expect(next.z).toBeCloseTo(-m.radius);
    expect(next.rotY).toBeCloseTo(50);
    expect(prev.rotY).toBeCloseTo(-50);
    expect(next.shade).toBeCloseTo(0.5);
  });

  it('desce um degrau por quadro (y cresce com o índice)', () => {
    for (const f of [0, 2.5]) {
      const ys = Array.from({ length: 20 }, (_, i) => framePose(i, f, m).y);
      ys.slice(1).forEach((y, i) => expect(y).toBeGreaterThan(ys[i]!));
    }
  });

  it('some aos poucos a partir de dois quadros de distância', () => {
    expect(framePose(2, 0, m).opacity).toBe(1);
    expect(framePose(2.5, 0, m).opacity).toBeCloseTo(0.5);
    expect(framePose(FADE_END, 0, m).visible).toBe(false);
    expect(framePose(-FADE_END - 1, 0, m).visible).toBe(false);
  });

  it('o foco percorre todas as fotos, qualquer que seja a quantidade', () => {
    expect(focusAt(0.5, 1)).toBe(0);
    expect(focusAt(1, 6)).toBe(5);
    expect(focusAt(0.5, 20)).toBeCloseTo(9.5);
    expect(focusAt(-1, 6)).toBe(0);
    expect(focusAt(2, 6)).toBe(5);
    for (const n of [1, 6, 20]) {
      const front = Array.from({ length: n }, (_, i) => framePose(i, focusAt(1, n), m)).filter((p) => p.front);
      expect(front).toHaveLength(1);
    }
  });

  it('progressFor leva cada quadro para a frente (inverso de focusAt)', () => {
    expect(progressFor(0, 1)).toBe(0);
    expect(progressFor(5, 1)).toBe(0);
    for (const n of [2, 6, 13, 20]) {
      for (let i = 0; i < n; i++) expect(focusAt(progressFor(i, n), n)).toBeCloseTo(i);
    }
    expect(progressFor(-2, 6)).toBe(0);
    expect(progressFor(9, 6)).toBe(1);
  });

  for (const [w, h] of VIEWPORTS) {
    it(`medidas cabem no palco ${w}×${h}`, () => {
      const t = towerMetrics(w, h);
      expect(t.verticalWidth).toBeLessThanOrEqual(w);
      expect(t.horizontalWidth).toBeLessThanOrEqual(w);
      expect((t.verticalWidth * 3) / 2).toBeLessThan(h);
      expect(t.radius).toBeGreaterThan(0);
      expect(t.step).toBeGreaterThan(0);
    });
  }
});
