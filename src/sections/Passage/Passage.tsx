import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ChevronDown } from 'lucide-react';
import { gsap, ScrollTrigger } from '../../animations/gsap';
import { useEffects } from '../../components/effects/EffectsContext';
import { useGsapScene } from '../../hooks/useGsapScene';
import { passage } from '../../content/texts';
import { archHalfWidthAt, buildWallLayout, createRandom } from '../../lib/brickWall';
import { paintAlley } from './paintAlley';
import { paintWall } from './paintWall';
import './passage.css';

/** Distância da câmera à parede (px) usada na perspectiva dos tijolos. */
const PERSPECTIVE = 900;
const TAP_RINGS = 3;

/**
 * Capítulo I — a parede do Caldeirão Furado. Cena fixada durante a rolagem
 * (justificativa narrativa: a "travessia"). Três toques de varinha num tijolo,
 * os tijolos tremem, recuam e deslizam para trás da parede formando um arco;
 * a luz do Beco Diagonal invade a cena e a câmera atravessa a passagem.
 */
export function Passage() {
  const ref = useRef<HTMLElement>(null);
  const wallRef = useRef<HTMLCanvasElement>(null);
  const alleyRef = useRef<HTMLCanvasElement>(null);
  const brickRefs = useRef(new Map<number, HTMLCanvasElement>());
  const { quality } = useEffects();
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  // Mede a cena; só remonta a parede quando o tamanho realmente muda.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      setSize((prev) => (prev && prev.w === w && Math.abs(prev.h - h) < 2 ? prev : { w, h }));
    };
    measure();
    let timer = 0;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(measure, 180);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, []);

  const layout = useMemo(() => (size ? buildWallLayout(size.w, size.h, quality === 'high' ? 8 : 6) : null), [size, quality]);

  // Tijolos móveis na ordem em que saem (os primeiros ficam por baixo no empilhamento).
  const archBricks = useMemo(() => (layout ? layout.cells.filter((c) => c.inArch).sort((a, b) => a.order - b.order) : []), [layout]);

  const decor = useMemo(() => {
    if (!layout) return null;
    const rand = createRandom(31);
    const { arch, groundY } = layout;
    const dust = Array.from({ length: quality === 'high' ? 34 : 18 }, () => ({
      x: arch.cx + (rand() * 2 - 1) * arch.halfWidth,
      y: arch.topY + rand() * (groundY - arch.topY) * 0.85,
      fall: 40 + rand() * 120,
      at: rand(),
      size: 1.5 + rand() * 2.5,
    }));
    // Feixes de luz irregulares saindo do arco.
    const stops: string[] = [];
    let angle = 0;
    while (angle < 360) {
      const gapDeg = 6 + rand() * 16;
      const beam = 1.5 + rand() * 4;
      const alpha = (0.025 + rand() * 0.06).toFixed(3);
      stops.push(`rgba(255,214,150,0) ${angle.toFixed(1)}deg`, `rgba(255,214,150,${alpha}) ${(angle + beam / 2).toFixed(1)}deg`, `rgba(255,214,150,0) ${(angle + beam).toFixed(1)}deg`);
      angle += beam + gapDeg;
    }
    return { dust, rays: `conic-gradient(from 0deg, ${stops.join(', ')})` };
  }, [layout, quality]);

  // Pinta parede, tijolos e beco sempre que a geometria muda.
  useLayoutEffect(() => {
    const wall = wallRef.current;
    const alley = alleyRef.current;
    if (!layout || !wall || !alley) return;
    const dpr = Math.min(window.devicePixelRatio || 1, quality === 'high' ? 2 : 1.5);
    paintWall(layout, dpr, wall, brickRefs.current);
    // O beco é ampliado na travessia: pintado com um pouco mais de resolução.
    const alleyDpr = Math.min(dpr * 1.25, 2);
    paintAlley(alley, layout, alleyDpr);
    let alive = true;
    if (document.fonts && document.fonts.status !== 'loaded') {
      document.fonts.ready.then(() => alive && paintAlley(alley, layout, alleyDpr)).catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [layout, quality]);

  useGsapScene(
    ref,
    ({ root, reducedMotion, quality: q }) => {
      if (reducedMotion || !layout) return;
      const { arch, cellW, vanishY, width, height, groundY } = layout;
      const select = gsap.utils.selector(root);
      const brickEls = select('.passage__brick') as HTMLElement[];

      const tl = gsap.timeline({
        defaults: { ease: 'none' },
        scrollTrigger: {
          trigger: root,
          start: 'top top',
          end: () => `+=${window.innerHeight * (q === 'high' ? 2.8 : 2.2)}`,
          scrub: 0.8,
          pin: true,
          anticipatePin: 1,
          invalidateOnRefresh: true,
          // A parede pode ser remontada depois dos outros gatilhos (redimensionamento).
          refreshPriority: 1,
        },
      });

      tl.to('.passage__hint', { opacity: 0, duration: 0.04 }, 0);
      // A seta só balança enquanto a dica pode ser vista (da entrada da cena até ela sumir).
      const hint = root.querySelector('.passage__hint');
      ScrollTrigger.create({
        trigger: root,
        start: 'top bottom',
        end: () => `+=${window.innerHeight * 1.2}`,
        invalidateOnRefresh: true,
        onToggle: (self) => hint?.classList.toggle('is-idle', !self.isActive),
      });
      tl.to('.passage__text', { opacity: 0, yPercent: -30, duration: 0.1, ease: 'power1.in' }, 0.02);

      // Três toques de varinha no tijolo.
      select('.passage__tap-ring').forEach((ring, i) => {
        const t = 0.07 + i * 0.035;
        tl.fromTo(ring, { scale: 0.2, opacity: 0 }, { scale: 0.9, opacity: 1, duration: 0.008 }, t).to(
          ring,
          { scale: 2.8, opacity: 0, duration: 0.03, ease: 'power1.out' },
          t + 0.008,
        );
      });
      tl.fromTo('.passage__tap-glow', { opacity: 0 }, { opacity: 1, duration: 0.1 }, 0.07).to('.passage__tap-glow', { opacity: 0, duration: 0.05 }, 0.2);

      // Cada tijolo: tremor, recuo e deslizamento para trás da parede.
      archBricks.forEach((cell, i) => {
        const el = brickEls[i];
        if (!el) return;
        const face = el.firstElementChild;
        const r = createRandom(cell.seed ^ 0x5bd1e995);
        const cy = cell.y + cell.h / 2;
        const dx = cell.x + cell.w / 2 - arch.cx;
        const t0 = 0.2 + cell.order * 0.36;

        if (cell.order < 0.16) {
          const a = 0.6 + r() * 0.9;
          tl.to(
            el,
            {
              keyframes: { x: [0, a, -a, a * 0.7, -a * 0.5, 0], y: [0, -a * 0.5, a * 0.6, -a * 0.4, a * 0.3, 0], rotationZ: [0, 0.7, -0.9, 0.5, -0.3, 0] },
              duration: Math.max(0.03, t0 - 0.15),
            },
            0.15,
          );
        }

        // Profundidade final e quanto deslizar para sumir atrás da borda do vão,
        // compensando a perspectiva (objetos mais fundos parecem mais perto do centro).
        const zAbs = 70 + r() * 140;
        const s = PERSPECTIVE / (PERSPECTIVE + zAbs);
        const projectedY = vanishY + (cy - vanishY) * s;
        const half = archHalfWidthAt(arch, projectedY) || archHalfWidthAt(arch, cy) || arch.halfWidth;
        const margin = cellW * (0.35 + r() * 0.9);
        const finalOffset = (half + margin) / s + cell.w / 2;
        const travel = cell.side * finalOffset - dx;

        tl.to(el, { z: -(8 + r() * 12), rotationX: (r() - 0.5) * 6, duration: 0.025, ease: 'power1.out' }, t0)
          .to(
            el,
            {
              x: travel,
              y: (r() - 0.5) * cell.h * 0.8,
              z: -zAbs,
              rotationY: cell.side * (35 + r() * 55),
              rotationX: (r() - 0.5) * 36,
              rotationZ: (r() - 0.5) * 14,
              duration: 0.085 + r() * 0.03,
              ease: 'power2.inOut',
            },
            t0 + 0.022,
          )
          .set(el, { visibility: 'hidden' }, t0 + 0.13);
        if (face) tl.to(face, { opacity: 0.35, duration: 0.1 }, t0 + 0.01);
      });

      // Poeira e argamassa caindo dos tijolos.
      select('.passage__dust').forEach((dot, i) => {
        const d = decor?.dust[i];
        if (!d) return;
        const t = 0.2 + d.at * 0.38;
        tl.fromTo(dot, { y: 0, opacity: 0 }, { keyframes: { opacity: [0, 0.9, 0.9, 0] }, y: d.fall, duration: 0.14, ease: 'power1.in' }, t);
      });

      // A luz do beco invade a cena.
      tl.fromTo('.passage__alley-dim', { opacity: 1 }, { opacity: 0, duration: 0.45 }, 0.18)
        .fromTo('.passage__rays', { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.42 }, 0.2)
        .fromTo('.passage__spill', { opacity: 0 }, { opacity: 1, duration: 0.4 }, 0.2);

      // A câmera atravessa o arco (parede e beco em velocidades diferentes: paralaxe).
      const through = Math.max(width / (arch.halfWidth * 2), height / (groundY - arch.topY)) * 1.9;
      tl.to('.passage__wall-layer', { scale: through, duration: 0.34, ease: 'power3.in' }, 0.6)
        .to('.passage__alley', { scale: 1.55, duration: 0.4, ease: 'power2.in' }, 0.56)
        .to('.passage__rays', { scale: 1.8, duration: 0.34, ease: 'power2.in' }, 0.62)
        .fromTo('.passage__flash', { opacity: 0 }, { opacity: 0.85, duration: 0.12, ease: 'power1.in' }, 0.8)
        .fromTo('.passage__veil', { opacity: 0 }, { opacity: 1, duration: 0.1 }, 0.9);

      // Pin criado depois dos demais gatilhos: reordena e recalcula as posições.
      ScrollTrigger.sort();
      ScrollTrigger.refresh();
    },
    [layout],
  );

  const origin = layout ? `${layout.arch.cx}px ${layout.vanishY}px` : '50% 50%';
  const key = layout ? layout.cells[layout.keyIndex] : undefined;

  return (
    <section ref={ref} id="travessia" className="passage" data-scene="passage" aria-labelledby="passage-title">
      <div className="passage__scene" aria-hidden="true">
        <div className="passage__alley" style={{ transformOrigin: origin }}>
          <canvas ref={alleyRef} className="passage__canvas" />
          <div className="passage__alley-dim" />
        </div>

        <div className="passage__wall-layer" style={{ transformOrigin: origin }}>
          <div className="passage__bricks" style={{ perspectiveOrigin: origin, perspective: `${PERSPECTIVE}px` }}>
            {archBricks.map((cell) => (
              <div key={cell.index} className="passage__brick" style={{ left: cell.x, top: cell.y, width: cell.w, height: cell.h }}>
                <canvas
                  ref={(el) => {
                    if (el) brickRefs.current.set(cell.index, el);
                    else brickRefs.current.delete(cell.index);
                  }}
                />
              </div>
            ))}
          </div>
          <canvas ref={wallRef} className="passage__canvas passage__wall" />
          {layout && (
            <div className="passage__spill" style={{ top: layout.groundY, left: layout.arch.cx - layout.arch.halfWidth * 2.5, width: layout.arch.halfWidth * 5 }} />
          )}
          {key && (
            <div className="passage__tap" style={{ left: key.x + key.w / 2, top: key.y + key.h / 2 }}>
              <span className="passage__tap-glow" style={{ '--w': `${key.w * 1.6}px`, '--h': `${key.h * 2.6}px` } as CSSProperties} />
              {Array.from({ length: TAP_RINGS }, (_, i) => (
                <span key={i} className="passage__tap-ring" />
              ))}
            </div>
          )}
          {decor?.dust.map((d, i) => (
            <span key={i} className="passage__dust" style={{ left: d.x, top: d.y, width: d.size, height: d.size }} />
          ))}
        </div>

        {layout && decor && (
          <div
            className="passage__rays"
            style={{
              '--size': `${Math.round(Math.max(layout.width, layout.height) * 2.2)}px`,
              left: layout.arch.cx,
              top: layout.vanishY,
              backgroundImage: `radial-gradient(closest-side, rgba(255,196,130,0.16), rgba(255,170,100,0.05) 30%, transparent 60%), ${decor.rays}`,
            } as CSSProperties}
          />
        )}
      </div>

      <div className="passage__text">
        <p className="kicker">{passage.kicker}</p>
        <h2 id="passage-title" className="chapter-title passage__title" tabIndex={-1} data-focus-target>
          {passage.title}
        </h2>
        <p className="passage__line">{passage.line}</p>
      </div>

      {/* Só orientação visual: para leitores de tela a rolagem já é o caminho natural. */}
      <p className="passage__hint" aria-hidden="true">
        <span>{passage.scrollHint}</span>
        <ChevronDown className="passage__hint-arrow" strokeWidth={1.5} />
      </p>

      <div className="passage__flash" aria-hidden="true" />
      <div className="passage__veil" aria-hidden="true" />
    </section>
  );
}
