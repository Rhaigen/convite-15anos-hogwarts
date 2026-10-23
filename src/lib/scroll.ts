import { gsap } from '../animations/gsap';
import { ScrollToPlugin } from 'gsap/ScrollToPlugin';

gsap.registerPlugin(ScrollToPlugin);

let active: gsap.core.Tween | null = null;

/**
 * Rola até uma âncora respeitando a preferência de movimento e move o foco
 * para a seção (acessibilidade em navegação por teclado/leitores de tela).
 *
 * Usa o ScrollToPlugin em vez de `scrollIntoView({behavior:'smooth'})`: a rolagem
 * nativa suave é cancelada quando o ScrollTrigger recalcula posições (ex.: ao
 * carregar imagens no caminho), deixando o visitante no meio da página.
 * Retorna `false` se o destino ainda não existir (deixa o link agir normalmente).
 */
export function scrollToId(id: string, reducedMotion: boolean): boolean {
  const target = document.getElementById(id);
  if (!target) return false;

  const focus = () => {
    const focusable = target.querySelector<HTMLElement>('[data-focus-target]') ?? target;
    if (!focusable.hasAttribute('tabindex')) focusable.setAttribute('tabindex', '-1');
    focusable.focus({ preventScroll: true });
  };
  if (window.location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);

  active?.kill();
  if (reducedMotion) {
    window.scrollTo(0, target.getBoundingClientRect().top + window.scrollY);
    focus();
    return true;
  }
  const distance = Math.abs(target.getBoundingClientRect().top);
  active = gsap.to(window, {
    scrollTo: { y: target, autoKill: false },
    duration: Math.min(2.2, 0.6 + distance / 6000),
    ease: 'power2.inOut',
    onComplete: () => {
      // Correção final caso o layout tenha mudado durante o trajeto (imagens, pins).
      const offset = target.getBoundingClientRect().top;
      if (Math.abs(offset) > 2) window.scrollTo(0, window.scrollY + offset);
      focus();
    },
  });
  return true;
}

/**
 * Rola suavemente até a posição `y` (px da página). Compartilha o tween de
 * `scrollToId`, então uma rolagem nova sempre substitui a anterior.
 */
export function scrollToY(y: number, duration: number, reducedMotion: boolean): void {
  active?.kill();
  active = null;
  if (reducedMotion || duration <= 0) {
    window.scrollTo(0, y);
    return;
  }
  active = gsap.to(window, { scrollTo: { y, autoKill: false }, duration, ease: 'power2.inOut' });
}
