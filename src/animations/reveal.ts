import { gsap } from './gsap';

/**
 * Revelações reutilizáveis disparadas pela rolagem. Usam gsap.from(), então
 * o estado final (visível) é o estado natural do CSS: se o script falhar,
 * o conteúdo continua legível.
 */

/** Título de capítulo: numeral, título surgindo de trás de uma máscara, filete. */
export function revealHeading(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('[data-reveal-heading]').forEach((heading) => {
    const tl = gsap.timeline({
      scrollTrigger: { trigger: heading, start: 'top 82%', once: true },
    });
    const part = (cls: string, vars: gsap.TweenVars, at: number) => {
      const el = heading.querySelector(cls);
      if (el) tl.from(el, vars, at);
    };
    part('.chapter-heading__kicker', { opacity: 0, y: 14, letterSpacing: '0.6em', duration: 1 }, 0);
    part('.chapter-heading__title', { opacity: 0, yPercent: 35, clipPath: 'inset(0 0 100% 0)', duration: 1.1, ease: 'power3.out' }, 0.15);
    part('.chapter-heading__divider', { opacity: 0, scaleX: 0.2, duration: 1, ease: 'power2.inOut' }, 0.4);
    part('.chapter-heading__intro', { opacity: 0, y: 12, duration: 0.9 }, 0.6);
  });
}

/** Elementos marcados com [data-reveal] surgem suavemente ao entrar na tela. */
export function revealOnEnter(root: HTMLElement, selector = '[data-reveal]', vars: gsap.TweenVars = {}): void {
  root.querySelectorAll<HTMLElement>(selector).forEach((el) => {
    gsap.from(el, {
      opacity: 0,
      y: 28,
      duration: 1,
      ease: 'power3.out',
      ...vars,
      scrollTrigger: { trigger: el, start: 'top 86%', once: true },
    });
  });
}
