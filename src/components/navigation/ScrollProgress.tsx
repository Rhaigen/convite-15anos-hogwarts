import { useEffect, useRef } from 'react';
import { gsap, ScrollTrigger } from '../../animations/gsap';

/** Fio dourado no topo indicando o progresso da jornada. */
export function ScrollProgress({ active }: { active: boolean }) {
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar || !active) return;
    const setScale = gsap.quickSetter(bar, 'scaleX');
    const trigger = ScrollTrigger.create({
      start: 0,
      end: 'max',
      onUpdate: (self) => setScale(self.progress),
    });
    return () => trigger.kill();
  }, [active]);

  return (
    <div className="scroll-progress" aria-hidden="true" data-active={active}>
      <div ref={barRef} className="scroll-progress__bar" />
    </div>
  );
}
