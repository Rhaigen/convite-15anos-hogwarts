import { useEffect, useState } from 'react';
import { computeCountdown, type CountdownState } from '../lib/countdown';

/**
 * Atualiza a cada virada de segundo (alinhado ao relógio), somente enquanto
 * `active` (seção visível) e a aba estiver em primeiro plano.
 */
export function useCountdown(target: Date, dayEnd: Date, active: boolean): CountdownState {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    let timer = 0;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      timer = window.setTimeout(tick, 1000 - (t % 1000) + 10);
    };
    const onVisibility = () => {
      window.clearTimeout(timer);
      if (!document.hidden) tick();
    };
    tick();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active]);

  return computeCountdown(target, dayEnd, now);
}
