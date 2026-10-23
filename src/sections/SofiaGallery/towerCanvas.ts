/**
 * Magia da torre (Capítulo III): a fita espiral de luz dourada que liga os
 * retratos (cometas, fios entrelaçados, faíscas) e o corredor de partículas que
 * corre ao longo dela. Tudo num Canvas 2D atrás dos quadros, com a mesma
 * perspectiva do palco CSS.
 *
 * O loop só roda com a torre visível e a aba ativa.
 */
import { createSprite } from '../../lib/particles';
import { ANGLE_STEP, type TowerMetrics } from './spiral';

export interface TowerCanvasOptions {
  canvas: HTMLCanvasElement;
  /** Elemento observado para ligar/desligar o loop. */
  target: Element;
  count: number;
  quality: 'high' | 'low';
  /** Índice fracionário do quadro na frente (já suavizado pela rolagem). */
  getFocus: () => number;
}

export interface TowerCanvas {
  resize: (width: number, height: number, metrics: TowerMetrics) => void;
  destroy: () => void;
}

/** Ouro luminoso, âmbar, lilás e prata (brasão da Sofia). Pesos: frequência de cada cor. */
const PALETTE: { core: string; rim: string; weight: number }[] = [
  { core: '255, 247, 222', rim: '246, 217, 138', weight: 0.4 },
  { core: '255, 236, 196', rim: '232, 160, 70', weight: 0.15 },
  { core: '246, 240, 255', rim: '200, 170, 255', weight: 0.25 },
  { core: '255, 255, 255', rim: '230, 235, 245', weight: 0.2 },
];

/**
 * A fita segue a mesma hélice dos quadros, um pouco por dentro dela: passa por
 * trás de cada retrato e liga um ao seguinte, como um fio de luz.
 */
const RIBBON_RADIUS = 0.92;
/** Quanto a fita se estende além do primeiro e do último quadro (em quadros). */
const RIBBON_TAIL = 1.4;
/** Distância média entre cometas de luz ao longo da fita (em quadros). */
const COMET_SPACING = 2.2;
const STEP_RAD = (ANGLE_STEP * Math.PI) / 180;

/**
 * Corredor de partículas: correm ao longo da fita, com a fita no meio, sempre atrás
 * dos quadros; a rolagem comanda o fluxo (descer → fita abaixo, subir → fita acima).
 */
const CORRIDOR_COUNT = { high: 520, low: 200 };
/** Trecho da fita (em quadros, para cada lado do foco) onde ficam as partículas do corredor. */
const CORRIDOR_WINDOW = 3.6;
/** Meia largura do corredor, em fração do raio da espiral. */
const CORRIDOR_HALF_WIDTH = 0.42;
/**
 * Velocidade das partículas ao longo da fita em relação à da espiral. Na tela elas
 * andam (CORRIDOR_FLOW − 1) × a velocidade dos quadros, no sentido oposto: 1,3 = 30%.
 * Mantenha entre 1 e 2 para nunca serem mais rápidas que os quadros.
 */
const CORRIDOR_FLOW = 1.3;
/**
 * Faixa extra além da borda do corredor (fração da meia largura), preenchida com
 * partículas novas na mesma densidade da borda; as do corredor original não mudam.
 */
const CORRIDOR_OUTER_BAND = 0.12;
/** Densidade na borda do corredor (por unidade de meia largura), conforme a distribuição de `dy`. */
const CORRIDOR_EDGE_DENSITY = 2 / 0.82;
/** Partículas extras perto da fita (fração do corredor), entre CORRIDOR_INNER_MIN e CORRIDOR_INNER_MAX. */
const CORRIDOR_INNER_EXTRA = 0.12;
/** Faixa perto da fita (fração da meia largura); abaixo do mínimo a fita fica livre. */
const CORRIDOR_INNER_MIN = 0.18;
const CORRIDOR_INNER_MAX = 0.5;
/** Comprimento máximo do rastro de uma partícula em movimento (px). */
const MAX_STREAK = 70;

/** Partícula do corredor: posição fixa na seção do corredor, correndo ao longo da fita. */
interface CorridorMote {
  /** Posição ao longo da fita (índice fracionário de quadro). */
  u: number;
  /** Desvio dentro do corredor: radial e vertical (px). */
  dr: number;
  dy: number;
  /** Deslize próprio, sem rolagem (quadros/s). */
  drift: number;
  size: number;
  alpha: number;
  phase: number;
  twinkle: number;
  sprite: number;
  /** Posição na tela no quadro anterior (para o rastro). */
  px: number;
  py: number;
  hasPrev: boolean;
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  sprite: number;
}

interface RibbonPoint {
  u: number;
  sx: number;
  sy: number;
  s: number;
  /** 0 (atrás do eixo) a 1 (na frente). */
  depth: number;
  /** 0–1: esmaece nas pontas da fita. */
  edge: number;
}

export function createTowerCanvas(options: TowerCanvasOptions): TowerCanvas | null {
  const { canvas, target, count, quality, getFocus } = options;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null; // Sem canvas: a torre segue sem a magia.

  const high = quality === 'high';
  const total = CORRIDOR_COUNT[quality];
  const samplesPerFrame = high ? 18 : 10;
  const sprites = PALETTE.map((c) => createSprite(c.core, c.rim));

  let width = 0;
  let height = 0;
  let metrics: TowerMetrics | null = null;
  let corridorMotes: CorridorMote[] = [];
  let raf = 0;
  let last = 0;
  let visible = false;
  let lastFocus = getFocus();
  let focusSpeed = 0;
  /** Posição dos cometas ao longo da fita (em quadros). */
  let flow = 0;
  let sparks: Spark[] = [];
  const maxSparks = high ? 140 : 50;

  const pickSprite = () => {
    let x = Math.random();
    for (let i = 0; i < PALETTE.length; i++) {
      x -= PALETTE[i]!.weight;
      if (x <= 0) return i;
    }
    return 0;
  };

  /** `zone`: corredor (mais denso nas laterais), faixa extra além da borda, ou reforço perto da fita. */
  const createCorridorMote = (focus: number, zone: 'corridor' | 'outer' | 'inner' = 'corridor'): CorridorMote => {
    const half = (metrics?.radius ?? 300) * CORRIDOR_HALF_WIDTH;
    const side = Math.random() < 0.5 ? -1 : 1;
    const r = Math.random();
    const spread =
      zone === 'outer'
        ? 1 + CORRIDOR_OUTER_BAND * r
        : zone === 'inner'
          ? CORRIDOR_INNER_MIN + (CORRIDOR_INNER_MAX - CORRIDOR_INNER_MIN) * r
          : CORRIDOR_INNER_MIN + (1 - CORRIDOR_INNER_MIN) * Math.sqrt(r);
    return {
      u: focus + (Math.random() * 2 - 1) * CORRIDOR_WINDOW,
      dr: (Math.random() * 2 - 1) * half * 0.35,
      dy: side * half * spread,
      drift: 0.1 + Math.random() * 0.15,
      size: Math.random() < 0.07 ? 3.2 + Math.random() * 2 : 1 + Math.random() * 2.3,
      alpha: 0.6 + Math.random() * 0.4,
      phase: Math.random() * Math.PI * 2,
      twinkle: 0.8 + Math.random() * 2.6,
      sprite: pickSprite(),
      px: 0,
      py: 0,
      hasPrev: false,
    };
  };

  /** Projeção igual à do palco: `perspective` com origem no centro. */
  const project = (x: number, y: number, z: number) => {
    const p = metrics!.perspective;
    const s = p / (p - z);
    return { sx: width / 2 + x * s, sy: height / 2 + y * s, s };
  };

  const ribbonStart = -RIBBON_TAIL;
  const ribbonEnd = count - 1 + RIBBON_TAIL;

  /** Ponto da hélice no índice fracionário `u`, com desvio radial/vertical opcional (fios entrelaçados). */
  const helixPoint = (u: number, focus: number, dr = 0, dy = 0): RibbonPoint => {
    const m = metrics!;
    const theta = (u - focus) * STEP_RAD;
    const r = m.radius * RIBBON_RADIUS + dr;
    const x = r * Math.sin(theta);
    const z = r * Math.cos(theta) - m.radius;
    const { sx, sy, s } = project(x, (u - focus) * m.step + dy, z);
    const edge = Math.min(1, (u - ribbonStart) / RIBBON_TAIL, (ribbonEnd - u) / RIBBON_TAIL);
    return { u, sx, sy, s, depth: (1 + Math.cos(theta)) / 2, edge: Math.max(0, edge) };
  };

  const segment = (a: RibbonPoint, b: RibbonPoint, color: string, alpha: number, width: number) => {
    if (alpha <= 0.008) return;
    ctx.strokeStyle = `rgba(${color}, ${Math.min(1, alpha).toFixed(3)})`;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(a.sx, a.sy);
    ctx.lineTo(b.sx, b.sy);
    ctx.stroke();
  };

  const emitSpark = (p: RibbonPoint) => {
    if (sparks.length >= maxSparks) return;
    const angle = Math.random() * Math.PI * 2;
    const speed = (12 + Math.random() * 40) * p.s;
    const life = 0.6 + Math.random() * 0.9;
    sparks.push({
      x: p.sx,
      y: p.sy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 10,
      life,
      maxLife: life,
      size: (0.8 + Math.random() * 1.6) * p.s,
      sprite: Math.random() < 0.6 ? 0 : 2 + ((Math.random() * 2) | 0),
    });
  };

  // A fita passa por trás dos quadros que ela liga.
  const drawRibbon = (focus: number, t: number, dt: number) => {
    // Só o trecho que pode aparecer no palco.
    const from = Math.max(ribbonStart, focus - 3.6);
    const to = Math.min(ribbonEnd, focus + 3.6);
    if (to <= from) return;
    const steps = Math.ceil((to - from) * samplesPerFrame);
    const R = metrics!.radius;
    const pts: RibbonPoint[] = [];
    for (let k = 0; k <= steps; k++) pts.push(helixPoint(from + ((to - from) * k) / steps, focus));

    // Fita principal: halo + núcleo, com um brilho que escorre ao longo dela.
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1]!;
      const b = pts[k]!;
      const base = b.edge * (0.45 + 0.55 * b.depth ** 1.5);
      const shimmer = 0.7 + 0.3 * Math.sin(b.u * 6 - t * 3.2);
      const breath = 1 + 0.2 * Math.sin(t * 1.8 + b.u * 1.3);
      if (high) segment(a, b, '232, 170, 80', 0.09 * base, 20 * b.s * breath);
      segment(a, b, '246, 217, 138', 0.28 * base * shimmer, 6 * b.s * breath);
      segment(a, b, '255, 244, 214', 0.85 * base * shimmer, 1.8 * b.s);
    }

    // Fios lilás e prata entrelaçados em volta da fita, girando sem parar.
    const strands = high ? 2 : 1;
    for (let j = 0; j < strands; j++) {
      const color = j === 0 ? '214, 190, 255' : '236, 242, 255';
      let prev: RibbonPoint | null = null;
      for (let k = 0; k <= steps; k++) {
        const u = from + ((to - from) * k) / steps;
        const phi = u * Math.PI * 2 * 1.1 + t * 2.4 + j * Math.PI;
        const amp = R * 0.07;
        const p = helixPoint(u, focus, amp * Math.cos(phi), amp * Math.sin(phi));
        if (prev) {
          // Mais brilhante quando o fio passa "por cima" da fita.
          const over = 0.45 + 0.55 * Math.max(0, Math.cos(phi));
          segment(prev, p, color, 0.6 * p.edge * over * (0.25 + 0.75 * p.depth ** 1.5), 1.1 * p.s);
        }
        prev = p;
      }
    }

    // Cometas: correm fita abaixo; a rolagem acelera (descer) ou inverte (subir).
    const flowSpeed = 0.45 + 0.9 * focusSpeed;
    flow += dt * flowSpeed;
    const dir = flowSpeed < 0 ? -1 : 1; // a cauda fica atrás do sentido do movimento
    const length = ribbonEnd - ribbonStart;
    const comets = Math.max(2, Math.round(length / COMET_SPACING));
    const tail = 0.9;
    for (let c = 0; c < comets; c++) {
      const offset = (((flow + (c * length) / comets) % length) + length) % length;
      const head = ribbonStart + offset;
      if (head < from - tail || head > to + tail) continue;
      const n = Math.ceil(tail * samplesPerFrame);
      let prev: RibbonPoint | null = null;
      for (let k = 0; k <= n; k++) {
        const u = head - (dir * tail * k) / n;
        if (u < from || u > to) {
          prev = null;
          continue;
        }
        const p = helixPoint(u, focus);
        if (prev) {
          const fade = (1 - k / n) ** 2;
          const a = p.edge * (0.35 + 0.65 * p.depth ** 1.5);
          segment(prev, p, '255, 236, 190', 0.35 * a * fade, 9 * p.s);
          segment(prev, p, '255, 252, 240', 0.95 * a * fade, 2.6 * p.s);
        }
        prev = p;
      }
      if (head >= from && head <= to) {
        const p = helixPoint(head, focus);
        const a = p.edge * (0.35 + 0.65 * p.depth ** 1.5);
        const size = 26 * p.s;
        ctx.globalAlpha = Math.min(1, a);
        ctx.drawImage(sprites[0]!, p.sx - size / 2, p.sy - size / 2, size, size);
        ctx.globalAlpha = 1;
        if (a > 0.2 && Math.random() < (high ? 0.7 : 0.35)) emitSpark(p);
      }
    }

    // Faíscas que se soltam dos cometas.
    const alive: Spark[] = [];
    for (const sp of sparks) {
      sp.life -= dt;
      if (sp.life <= 0) continue;
      sp.vx *= 0.97;
      sp.vy = sp.vy * 0.97 + 18 * dt;
      sp.x += sp.vx * dt;
      sp.y += sp.vy * dt;
      const k = sp.life / sp.maxLife;
      const size = sp.size * 4;
      ctx.globalAlpha = Math.min(1, k * (0.6 + 0.4 * Math.sin(sp.life * 30)));
      ctx.drawImage(sprites[sp.sprite]!, sp.x - size / 2, sp.y - size / 2, size, size);
      alive.push(sp);
    }
    ctx.globalAlpha = 1;
    sparks = alive;
  };

  // Corredor de partículas ao longo da fita (sempre atrás dos quadros).
  const drawCorridor = (dt: number, t: number, focus: number) => {
    const span = CORRIDOR_WINDOW * 2;
    const tails = new Path2D();
    const heads = new Path2D();
    for (const p of corridorMotes) {
      // A rolagem empurra o fluxo; parado, só um deslize lento fita abaixo.
      p.u += (p.drift + CORRIDOR_FLOW * focusSpeed) * dt;
      if (p.u < focus - CORRIDOR_WINDOW || p.u > focus + CORRIDOR_WINDOW) {
        p.u += p.u < focus ? span : -span;
        p.hasPrev = false;
      }
      if (p.u < ribbonStart || p.u > ribbonEnd) {
        p.hasPrev = false;
        continue;
      }
      const pt = helixPoint(p.u, focus, p.dr, p.dy);
      const a = 1.15 * p.alpha * pt.edge * (0.5 + 0.5 * pt.depth ** 1.5) * (0.72 + 0.28 * Math.sin(t * p.twinkle + p.phase));
      if (a > 0.01) {
        // Rastro de luz quando o corredor está em movimento (desenhado em lote no fim).
        if (p.hasPrev) {
          let dx = p.px - pt.sx;
          let dy = p.py - pt.sy;
          const len = Math.hypot(dx, dy);
          if (len > 1.5 && a > 0.3) {
            if (len > MAX_STREAK) {
              dx *= MAX_STREAK / len;
              dy *= MAX_STREAK / len;
            }
            tails.moveTo(pt.sx, pt.sy);
            tails.lineTo(pt.sx + dx, pt.sy + dy);
            heads.moveTo(pt.sx, pt.sy);
            heads.lineTo(pt.sx + dx * 0.4, pt.sy + dy * 0.4);
          }
        }
        const size = p.size * 4 * pt.s;
        ctx.globalAlpha = Math.min(1, a);
        ctx.drawImage(sprites[p.sprite]!, pt.sx - size / 2, pt.sy - size / 2, size, size);
        ctx.globalAlpha = 1;
      }
      p.px = pt.sx;
      p.py = pt.sy;
      p.hasPrev = true;
    }
    // Rastro afinando: traço longo e fraco + traço curto e forte junto à partícula.
    ctx.lineWidth = high ? 1.4 : 1.1;
    ctx.strokeStyle = 'rgba(255, 236, 196, 0.22)';
    ctx.stroke(tails);
    ctx.strokeStyle = 'rgba(255, 246, 222, 0.55)';
    ctx.stroke(heads);
  };

  const tick = (now: number) => {
    raf = 0;
    if (!metrics || width === 0) return;
    const dt = Math.min(0.05, (now - last) / 1000) || 0.016;
    last = now;
    const t = now / 1000;
    const focus = getFocus();
    // Velocidade da espiral (quadros/s), suavizada.
    const instant = (focus - lastFocus) / dt;
    lastFocus = focus;
    focusSpeed += (Math.max(-6, Math.min(6, instant)) - focusSpeed) * Math.min(1, dt * 6);

    ctx.clearRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    drawRibbon(focus, t, dt);
    drawCorridor(dt, t, focus);
    raf = requestAnimationFrame(tick);
  };

  const start = () => {
    if (raf || !visible || document.hidden || !metrics) return;
    last = performance.now();
    lastFocus = getFocus();
    raf = requestAnimationFrame(tick);
  };

  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  const onVisibility = () => (document.hidden ? stop() : start());
  document.addEventListener('visibilitychange', onVisibility);
  // Vale a entrada mais recente (um aviso pode trazer várias num salto de rolagem).
  const observer = new IntersectionObserver((entries) => {
    visible = !!entries.at(-1)?.isIntersecting;
    if (visible) start();
    else stop();
  });
  observer.observe(target);

  return {
    resize(w, h, m) {
      const dpr = Math.min(window.devicePixelRatio || 1, high ? 1.5 : 1);
      width = w;
      height = h;
      metrics = m;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (corridorMotes.length === 0) {
        const outer = Math.round(total * CORRIDOR_OUTER_BAND * CORRIDOR_EDGE_DENSITY);
        const inner = Math.round(total * CORRIDOR_INNER_EXTRA);
        const focus = getFocus();
        corridorMotes = [
          ...Array.from({ length: total }, () => createCorridorMote(focus)),
          ...Array.from({ length: outer }, () => createCorridorMote(focus, 'outer')),
          ...Array.from({ length: inner }, () => createCorridorMote(focus, 'inner')),
        ];
      }
      start();
    },
    destroy() {
      stop();
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      corridorMotes = [];
      sparks = [];
    },
  };
}
