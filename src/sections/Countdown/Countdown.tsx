import { useMemo, useRef } from 'react';
import { gsap } from '../../animations/gsap';
import { revealHeading } from '../../animations/reveal';
import { ChapterHeading } from '../../components/ui/ChapterHeading';
import { event } from '../../content/event';
import { countdown as copy } from '../../content/texts';
import { useCountdown } from '../../hooks/useCountdown';
import { useGsapScene } from '../../hooks/useGsapScene';
import { useInView } from '../../hooks/useInView';
import { describeCountdown, unitLabel, type CountdownUnit } from '../../lib/countdown';
import { formatTime, getEventDayEnd, getEventStart } from '../../lib/date';
import { Hourglass } from './Hourglass';
import './countdown.css';

const UNITS: CountdownUnit[] = ['days', 'hours', 'minutes', 'seconds'];

/** Capítulo VI — contagem regressiva real até o início da festa. */
export function Countdown() {
  const ref = useRef<HTMLElement>(null);
  const target = useMemo(() => getEventStart(event), []);
  const dayEnd = useMemo(() => getEventDayEnd(event), []);
  const inView = useInView(ref);
  const state = useCountdown(target, dayEnd, inView);

  useGsapScene(ref, ({ root, reducedMotion }) => {
    if (reducedMotion) return;
    revealHeading(root);
    gsap
      .timeline({ scrollTrigger: { trigger: '.countdown__layout', start: 'top 80%', once: true } })
      .from('.countdown__hourglass', { opacity: 0, y: 40, rotation: -8, duration: 1.2, ease: 'power3.out' })
      .from('.countdown__unit', { opacity: 0, y: 30, rotationX: -60, transformPerspective: 600, stagger: 0.12, duration: 0.9, ease: 'power3.out' }, 0.2)
      .from('.countdown__note', { opacity: 0, duration: 0.8 }, 0.8);
    gsap.fromTo('.countdown__hourglass', { yPercent: 8 }, { yPercent: -8, ease: 'none', scrollTrigger: { trigger: root, start: 'top bottom', end: 'bottom top', scrub: true } });
  });

  const note = event.time ? copy.confirmedNote(formatTime(event.time), event.timezoneLabel) : copy.provisionalNote(event.timezoneLabel);

  return (
    <section ref={ref} id="contagem" className="countdown section-shell" data-scene="countdown" aria-labelledby="countdown-title">
      <ChapterHeading id="countdown-title" kicker={copy.kicker} title={copy.title} intro={copy.intro} />

      <div className="countdown__layout">
        <Hourglass className="countdown__hourglass" />

        {state.status === 'upcoming' ? (
          <div className="countdown__timer" role="timer" aria-label={describeCountdown(state)}>
            {UNITS.map((unit) => {
              const value = state[unit];
              const shown = unit === 'days' ? String(value) : String(value).padStart(2, '0');
              return (
                <div key={unit} className="countdown__unit" aria-hidden="true">
                  <span key={shown} className="countdown__value">
                    {shown}
                  </span>
                  <span className="countdown__label">{unitLabel(unit, value)}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="countdown__done" role="status">
            {state.status === 'today' ? copy.todayMessage : copy.pastMessage}
          </p>
        )}
      </div>

      {state.status === 'upcoming' && <p className="countdown__note">{note}</p>}
    </section>
  );
}
