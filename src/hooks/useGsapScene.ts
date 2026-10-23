import { useLayoutEffect, type DependencyList, type RefObject } from 'react';
import { gsap } from '../animations/gsap';
import { useEffects, type EffectsQuality } from '../components/effects/EffectsContext';

export interface SceneEnv {
  root: HTMLElement;
  reducedMotion: boolean;
  quality: EffectsQuality;
}

/**
 * Executa a coreografia GSAP de uma cena dentro de um gsap.context(),
 * garantindo que tweens, timelines e ScrollTriggers sejam revertidos ao
 * desmontar ou quando a preferência de movimento mudar (sem duplicações).
 */
export function useGsapScene(
  scope: RefObject<HTMLElement | null>,
  setup: (env: SceneEnv) => void | (() => void),
  deps: DependencyList = [],
): void {
  const { reducedMotion, quality } = useEffects();

  useLayoutEffect(() => {
    const root = scope.current;
    if (!root) return;
    let cleanup: void | (() => void);
    const ctx = gsap.context(() => {
      cleanup = setup({ root, reducedMotion, quality });
    }, root);
    return () => {
      cleanup?.();
      ctx.revert();
    };
    // `setup` é recriada a cada render; as dependências reais são explicitadas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reducedMotion, quality, ...deps]);
}
