import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMediaQuery, useSystemReducedMotion } from '../../hooks/useMediaQuery';
import { particles } from '../../lib/particles';

export type MotionPreference = 'system' | 'full' | 'reduced';
export type EffectsQuality = 'high' | 'low';

export interface EffectsValue {
  /** Resultado final: animações intensas devem ser evitadas. */
  reducedMotion: boolean;
  systemReducedMotion: boolean;
  motionPreference: MotionPreference;
  setMotionPreference: (pref: MotionPreference) => void;
  /** Nível de efeitos conforme o dispositivo (partículas, sombras, camadas). */
  quality: EffectsQuality;
  /** Ponteiro preciso (mouse/trackpad) — habilita o rastro mágico do cursor. */
  finePointer: boolean;
}

const STORAGE_KEY = 'sofia15:motion';
const EffectsContext = createContext<EffectsValue | null>(null);

function readStoredPreference(): MotionPreference {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'full' || value === 'reduced' ? value : 'system';
  } catch {
    return 'system';
  }
}

function detectLowPowerDevice(): boolean {
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  return (
    (nav.hardwareConcurrency !== undefined && nav.hardwareConcurrency <= 4) ||
    (nav.deviceMemory !== undefined && nav.deviceMemory <= 4) ||
    nav.connection?.saveData === true
  );
}

/**
 * Controlador central de efeitos: decide intensidade das animações e
 * partículas conforme preferência do visitante e capacidade do dispositivo.
 */
export function EffectsProvider({ children }: { children: ReactNode }) {
  const systemReducedMotion = useSystemReducedMotion();
  const finePointer = useMediaQuery('(hover: hover) and (pointer: fine)');
  const narrow = useMediaQuery('(max-width: 767px)');
  const [motionPreference, setPref] = useState<MotionPreference>(readStoredPreference);
  const [lowPower] = useState(detectLowPowerDevice);

  const reducedMotion = motionPreference === 'system' ? systemReducedMotion : motionPreference === 'reduced';
  const quality: EffectsQuality = narrow || !finePointer || lowPower ? 'low' : 'high';

  const setMotionPreference = useCallback((pref: MotionPreference) => {
    setPref(pref);
    try {
      if (pref === 'system') window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, pref);
    } catch {
      /* armazenamento indisponível (modo privado) — a preferência vale só nesta visita */
    }
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.motion = reducedMotion ? 'reduced' : 'full';
    root.dataset.quality = quality;
    particles.configure({ reducedMotion, quality });
  }, [reducedMotion, quality]);

  const value = useMemo<EffectsValue>(
    () => ({ reducedMotion, systemReducedMotion, motionPreference, setMotionPreference, quality, finePointer }),
    [reducedMotion, systemReducedMotion, motionPreference, setMotionPreference, quality, finePointer],
  );

  return <EffectsContext.Provider value={value}>{children}</EffectsContext.Provider>;
}

export function useEffects(): EffectsValue {
  const ctx = useContext(EffectsContext);
  if (!ctx) throw new Error('useEffects precisa estar dentro de <EffectsProvider>.');
  return ctx;
}
