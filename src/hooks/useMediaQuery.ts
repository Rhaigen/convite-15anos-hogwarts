import { useCallback, useSyncExternalStore } from 'react';

/** Acompanha uma media query de forma segura para concorrência. */
export function useMediaQuery(query: string, fallback = false): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener('change', notify);
      return () => mql.removeEventListener('change', notify);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : fallback),
    () => fallback,
  );
}

/** Preferência de movimento reduzido do sistema operacional. */
export function useSystemReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}
