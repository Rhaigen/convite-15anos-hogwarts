import { gsap } from './gsap';
import { particles } from '../lib/particles';

export interface OpeningElements {
  overlay: HTMLElement;
  envelope: HTMLElement;
  tilt: HTMLElement;
  heading: HTMLElement;
  hint: HTMLElement;
  halo: HTMLElement;
  flash: HTMLElement;
  fly: HTMLElement;
}

export interface OpeningCallbacks {
  /** A carta real começa a ser revelada (texto progressivo). */
  onReveal: () => void;
  /** Sequência concluída: a cena de abertura pode ser removida. */
  onComplete: () => void;
}

export interface OpeningSequence {
  kill: () => void;
}

function centerOf(el: Element) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function must(root: HTMLElement, selector: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`Elemento do envelope ausente: ${selector}`);
  return found;
}

/**
 * Coreografia da abertura (~4,2 s):
 *  0.0  resposta imediata ao toque (compressão e realce do envelope)
 *  0.1  o selo recebe brilho dourado
 *  0.7  o selo se parte em duas metades com faíscas
 *  0.9  a aba se abre em 3D
 *  1.6  a carta emerge lentamente
 *  2.6  a carta se desprende e se expande até a posição legível (FLIP)
 *  3.4  clarão dourado, a cena se dissolve e o texto é revelado
 */
export function createOpeningSequence(
  el: OpeningElements,
  target: HTMLElement,
  { onReveal, onComplete }: OpeningCallbacks,
): OpeningSequence {
  const flap = must(el.envelope, '[data-env-flap]');
  const seal = must(el.envelope, '[data-env-seal]');
  const sealGlow = must(el.envelope, '[data-env-seal-glow]');
  const sealLeft = must(el.envelope, '[data-env-seal-left]');
  const sealRight = must(el.envelope, '[data-env-seal-right]');
  const letter = must(el.envelope, '[data-env-letter]');
  const pulse = must(el.envelope, '.envelope__seal-pulse');
  const fadeParts = el.envelope.querySelectorAll('[data-env-fade]');

  let handoff: gsap.core.Timeline | null = null;
  const tl = gsap.timeline({ defaults: { ease: 'power2.inOut' } });

  // 1–2. Resposta imediata e destaque
  tl.set(flap, { filter: 'none', transformPerspective: 1100 }, 0)
    .to(pulse, { opacity: 0, duration: 0.2 }, 0)
    .to(el.hint, { opacity: 0, y: 10, duration: 0.35 }, 0)
    .to(el.heading, { opacity: 0, y: -14, duration: 0.6 }, 0)
    .to(el.tilt, { rotationX: 0, rotationY: 0, duration: 0.5, ease: 'power2.out' }, 0)
    .to(el.envelope, { scale: 0.965, duration: 0.12, ease: 'power1.out' }, 0)
    .to(el.envelope, { scale: 1.035, duration: 0.6, ease: 'back.out(2.2)' }, 0.12)
    .to(el.halo, { opacity: 0.85, scale: 1.08, duration: 1.2, ease: 'power2.out' }, 0.05);

  // 3. Brilho no selo
  tl.to(sealGlow, { opacity: 1, scale: 1.25, duration: 0.55, ease: 'power2.out' }, 0.1)
    .to(seal, { scale: 1.1, duration: 0.45, ease: 'power2.out' }, 0.1)
    .call(
      () => {
        const c = centerOf(seal);
        particles.burst(c.x, c.y, { count: 18, speed: 90, life: 0.9, size: 2.2, gravity: -10 });
      },
      undefined,
      0.35,
    );

  // 4. O selo se rompe em duas metades
  tl.call(
    () => {
      const c = centerOf(seal);
      particles.burst(c.x, c.y, { count: 64, speed: 300, life: 1.5, size: 3, gravity: 60 });
    },
    undefined,
    0.72,
  )
    .to(sealLeft, { xPercent: -42, yPercent: 85, rotation: -34, opacity: 0, duration: 0.85, ease: 'power2.in' }, 0.72)
    .to(sealRight, { xPercent: 42, yPercent: 95, rotation: 30, opacity: 0, duration: 0.85, ease: 'power2.in' }, 0.72)
    .to(sealGlow, { opacity: 0, scale: 2.4, duration: 0.8, ease: 'power2.out' }, 0.75);

  // 5. A aba se abre em 3D (troca de camada ao passar de 90°)
  tl.to(flap, { rotationX: 180, duration: 0.95, ease: 'power2.inOut' }, 0.9).set(flap, { zIndex: 2 }, 1.38);

  // 6. A carta emerge lentamente
  tl.to(letter, { yPercent: -60, duration: 1.1, ease: 'power3.out' }, 1.65).to(
    el.envelope,
    { yPercent: 12, duration: 1.1, ease: 'power2.out' },
    1.65,
  );

  // 7–10. A carta se expande até a posição legível; clarão; a cena se dissolve
  tl.call(
    () => {
      const from = letter.getBoundingClientRect();
      const to = target.getBoundingClientRect();
      gsap.set(el.fly, { display: 'block', left: from.left, top: from.top, width: from.width, height: from.height, opacity: 1 });
      gsap.set(letter, { opacity: 0 });
      handoff = gsap
        .timeline({ onComplete })
        .to(fadeParts, { opacity: 0, y: '+=40', duration: 0.7, ease: 'power2.in', stagger: 0.03 }, 0)
        .to(el.halo, { opacity: 0.4, scale: 1.4, duration: 1.2 }, 0)
        .to(el.fly, { left: to.left, top: to.top, width: to.width, height: to.height, duration: 1.2, ease: 'power3.inOut' }, 0)
        .to(el.fly.querySelectorAll('[data-fly-content]'), { opacity: 0, duration: 0.5 }, 0.95)
        .to(el.flash, { opacity: 0.6, duration: 0.55, ease: 'power2.out' }, 0.5)
        .call(onReveal, undefined, 1.05)
        .call(
          () => {
            const x = to.left + to.width / 2;
            const y = Math.min(to.top + 90, window.innerHeight * 0.4);
            particles.burst(x, y, { count: 46, speed: 260, life: 1.6, size: 2.6, gravity: -20, angle: -Math.PI / 2, spread: Math.PI * 1.4 });
          },
          undefined,
          1.15,
        )
        .to(el.flash, { opacity: 0, duration: 0.9, ease: 'power2.inOut' }, 1.1)
        .to(el.overlay, { opacity: 0, duration: 0.6, ease: 'power1.inOut' }, 1.2);
    },
    undefined,
    2.65,
  );

  return {
    kill: () => {
      tl.kill();
      handoff?.kill();
    },
  };
}
