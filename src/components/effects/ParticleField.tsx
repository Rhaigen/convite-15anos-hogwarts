import { useEffect, useRef } from 'react';
import { particles } from '../../lib/particles';
import { useEffects } from './EffectsContext';

/**
 * Canvas global de partículas + rastro dourado discreto do cursor.
 * O cursor padrão nunca é substituído: o rastro apenas o acompanha.
 */
export function ParticleField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { finePointer, reducedMotion } = useEffects();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    particles.attach(canvas);
    return () => particles.detach();
  }, []);

  useEffect(() => {
    if (!finePointer || reducedMotion) return;
    let lastX = 0;
    let lastY = 0;
    let lastTime = 0;
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      const now = performance.now();
      const dist = Math.hypot(e.clientX - lastX, e.clientY - lastY);
      if (now - lastTime < 28 || dist < 8) return;
      lastX = e.clientX;
      lastY = e.clientY;
      lastTime = now;
      particles.spark(e.clientX, e.clientY);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [finePointer, reducedMotion]);

  return <canvas ref={canvasRef} className="particle-field" aria-hidden="true" />;
}
