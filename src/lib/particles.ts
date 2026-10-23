/**
 * Motor de partículas mágicas em Canvas 2D (um único canvas para todo o site).
 *
 * - Poeira dourada ambiente com densidade ajustável por cena.
 * - Explosões pontuais (selo rompido, envio de resposta, encerramento).
 * - Faíscas do rastro do cursor.
 *
 * Limites: quantidade proporcional à área visível e ao nível de qualidade,
 * teto absoluto de partículas, DPR limitado e pausa quando a aba fica oculta.
 */

type Kind = 'mote' | 'burst' | 'spark';

interface Particle {
  kind: Kind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  life: number;
  maxLife: number;
  alpha: number;
  phase: number;
  twinkle: number;
  sprite: number;
}

export interface BurstOptions {
  count?: number;
  speed?: number;
  spread?: number;
  /** Ângulo central em radianos (padrão: todas as direções). */
  angle?: number;
  gravity?: number;
  life?: number;
  size?: number;
}

interface EngineConfig {
  reducedMotion: boolean;
  quality: 'high' | 'low';
}

const MAX_PARTICLES = 320;
const SPRITE_COLORS: [string, string][] = [
  ['255, 247, 222', '246, 217, 138'], // ouro luminoso
  ['255, 236, 196', '232, 160, 70'], // âmbar
  ['255, 255, 245', '216, 177, 90'], // brilho branco-dourado
];

class ParticleEngine {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private sprites: HTMLCanvasElement[] = [];
  private particles: Particle[] = [];
  private width = 0;
  private height = 0;
  private dpr = 1;
  private raf = 0;
  private last = 0;
  private ambientLevel = 0.6;
  private config: EngineConfig = { reducedMotion: false, quality: 'high' };
  private resizePending = false;

  attach(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return; // Canvas indisponível: o site segue sem partículas.
    this.canvas = canvas;
    this.ctx = ctx;
    this.sprites = SPRITE_COLORS.map(([core, rim]) => createSprite(core, rim));
    this.resize();
    window.addEventListener('resize', this.onResize, { passive: true });
    document.addEventListener('visibilitychange', this.onVisibility);
    this.seedAmbient(true);
    this.start();
  }

  detach(): void {
    this.stop();
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.particles = [];
    this.canvas = null;
    this.ctx = null;
  }

  configure(config: EngineConfig): void {
    this.config = config;
    this.resize();
    if (config.reducedMotion) {
      this.particles = [];
      this.clear();
      this.stop();
      return;
    }
    this.seedAmbient(false);
    this.start();
  }

  /** Densidade da poeira ambiente (0–1), ajustada por cena. */
  setAmbient(level: number): void {
    this.ambientLevel = Math.max(0, Math.min(1, level));
    this.seedAmbient(false);
    this.start();
  }

  burst(x: number, y: number, options: BurstOptions = {}): void {
    if (!this.ctx || this.config.reducedMotion) return;
    const scale = this.config.quality === 'low' ? 0.55 : 1;
    const count = Math.round((options.count ?? 40) * scale);
    const speed = options.speed ?? 220;
    const spread = options.spread ?? Math.PI * 2;
    const angle = options.angle ?? 0;
    for (let i = 0; i < count && this.particles.length < MAX_PARTICLES; i++) {
      const a = angle + (Math.random() - 0.5) * spread;
      const v = speed * (0.25 + Math.random() * 0.75);
      const life = (options.life ?? 1.4) * (0.55 + Math.random() * 0.6);
      this.particles.push({
        kind: 'burst',
        x,
        y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        size: (options.size ?? 3) * (0.5 + Math.random()),
        life,
        maxLife: life,
        alpha: 1,
        phase: Math.random() * Math.PI * 2,
        twinkle: 6 + Math.random() * 8,
        sprite: (Math.random() * this.sprites.length) | 0,
      });
    }
    this.gravityOverride = options.gravity ?? 40;
    this.start();
  }

  /** Pequena faísca do rastro do cursor. */
  spark(x: number, y: number): void {
    if (!this.ctx || this.config.reducedMotion || this.particles.length >= MAX_PARTICLES) return;
    const life = 0.45 + Math.random() * 0.35;
    this.particles.push({
      kind: 'spark',
      x: x + (Math.random() - 0.5) * 6,
      y: y + (Math.random() - 0.5) * 6,
      vx: (Math.random() - 0.5) * 24,
      vy: 10 + Math.random() * 30,
      size: 1.2 + Math.random() * 1.6,
      life,
      maxLife: life,
      alpha: 0.9,
      phase: 0,
      twinkle: 0,
      sprite: 0,
    });
    this.start();
  }

  private gravityOverride = 40;

  private targetMotes(): number {
    const area = this.width * this.height;
    const cap = this.config.quality === 'high' ? 70 : 26;
    const base = Math.min(cap, Math.max(10, area / 20000));
    return Math.round(base * this.ambientLevel);
  }

  private seedAmbient(initial: boolean): void {
    if (!this.ctx || this.config.reducedMotion) return;
    const motes = this.particles.filter((p) => p.kind === 'mote').length;
    const missing = this.targetMotes() - motes;
    for (let i = 0; i < missing; i++) this.particles.push(this.createMote(initial || Math.random() < 0.5));
  }

  private createMote(anywhere: boolean): Particle {
    return {
      kind: 'mote',
      x: Math.random() * this.width,
      y: anywhere ? Math.random() * this.height : this.height + 10,
      vx: (Math.random() - 0.5) * 6,
      vy: -(6 + Math.random() * 18),
      size: 0.8 + Math.random() * 2.2,
      life: Infinity,
      maxLife: Infinity,
      alpha: 0.18 + Math.random() * 0.5,
      phase: Math.random() * Math.PI * 2,
      twinkle: 0.6 + Math.random() * 1.8,
      sprite: (Math.random() * this.sprites.length) | 0,
    };
  }

  private onResize = (): void => {
    if (this.resizePending) return;
    this.resizePending = true;
    requestAnimationFrame(() => {
      this.resizePending = false;
      this.resize();
    });
  };

  private onVisibility = (): void => {
    if (document.hidden) this.stop();
    else this.start();
  };

  private resize(): void {
    if (!this.canvas || !this.ctx) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, this.config.quality === 'high' ? 1.75 : 1.25);
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  private start(): void {
    if (this.raf || !this.ctx || this.config.reducedMotion || document.hidden) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  private stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private clear(): void {
    this.ctx?.clearRect(0, 0, this.width, this.height);
  }

  private tick = (now: number): void => {
    const ctx = this.ctx;
    if (!ctx) return;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    const t = now / 1000;
    this.last = now;

    ctx.clearRect(0, 0, this.width, this.height);
    ctx.globalCompositeOperation = 'lighter';

    const targetMotes = this.targetMotes();
    let motes = 0;
    const alive: Particle[] = [];

    for (const p of this.particles) {
      if (p.kind === 'mote') {
        motes++;
        if (motes > targetMotes) continue; // reduz suavemente ao trocar de cena
        p.x += (p.vx + Math.sin(t * 0.6 + p.phase) * 8) * dt;
        p.y += p.vy * dt;
        if (p.y < -12) Object.assign(p, this.createMote(false));
        const a = p.alpha * (0.55 + 0.45 * Math.sin(t * p.twinkle + p.phase));
        this.draw(ctx, p, a);
        alive.push(p);
        continue;
      }

      p.life -= dt;
      if (p.life <= 0) continue;
      const drag = Math.exp(-(p.kind === 'burst' ? 2.4 : 1.2) * dt);
      p.vx *= drag;
      p.vy = p.vy * drag + (p.kind === 'burst' ? this.gravityOverride : 30) * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const k = p.life / p.maxLife;
      const flicker = p.kind === 'burst' ? 0.75 + 0.25 * Math.sin(t * p.twinkle + p.phase) : 1;
      this.draw(ctx, p, p.alpha * k * flicker);
      alive.push(p);
    }

    this.particles = alive;
    if (motes < targetMotes) this.seedAmbient(false);

    if (this.particles.length === 0) {
      this.stop();
      return;
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private draw(ctx: CanvasRenderingContext2D, p: Particle, alpha: number): void {
    const sprite = this.sprites[p.sprite];
    if (!sprite || alpha <= 0.01) return;
    const s = p.size * 4;
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.drawImage(sprite, p.x - s / 2, p.y - s / 2, s, s);
  }
}

/** Sprite radial (núcleo claro + halo) pré-renderizado, reaproveitado por outros canvas. */
export function createSprite(core: string, rim: string): HTMLCanvasElement {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  if (!g) return c;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, `rgba(${core}, 1)`);
  grad.addColorStop(0.18, `rgba(${core}, 0.9)`);
  grad.addColorStop(0.35, `rgba(${rim}, 0.45)`);
  grad.addColorStop(1, `rgba(${rim}, 0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

export const particles = new ParticleEngine();
