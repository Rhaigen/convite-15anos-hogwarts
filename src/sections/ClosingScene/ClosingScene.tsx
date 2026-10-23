import { useRef, type MouseEvent } from 'react';
import { ArrowUp, Gift, Send } from 'lucide-react';
import { CLOSING_LIGHT } from '../../animations/ambient';
import { gsap } from '../../animations/gsap';
import { Candles } from '../../components/effects/Candles';
import { useEffects } from '../../components/effects/EffectsContext';
import { SofiaCrest } from '../../components/ui/SofiaCrest';
import { Divider } from '../../components/ui/Ornaments';
import { event } from '../../content/event';
import { closing } from '../../content/texts';
import { useGsapScene } from '../../hooks/useGsapScene';
import { getDateParts } from '../../lib/date';
import { particles } from '../../lib/particles';
import { scrollToId } from '../../lib/scroll';
import './closing.css';

/**
 * Capítulo X — encerramento: um feixe de luz atravessa a tela, o brasão
 * reaparece entre faíscas e o nome completo surge em destaque. Os botões
 * levam de volta à confirmação, aos presentes e à carta.
 */
export function ClosingScene() {
  const ref = useRef<HTMLElement>(null);
  const { reducedMotion } = useEffects();
  const parts = getDateParts(event.date);
  const monthNumber = event.date.slice(5, 7);

  useGsapScene(ref, ({ root, reducedMotion: reduced }) => {
    if (reduced) return;
    gsap.fromTo(
      '.closing__beam',
      { xPercent: -130, opacity: 0 },
      {
        xPercent: 130,
        opacity: 1,
        ease: 'none',
        scrollTrigger: { trigger: root, start: 'top 85%', end: 'top 5%', scrub: 0.8 },
      },
    );
    gsap
      .timeline({
        scrollTrigger: {
          trigger: '.closing__content',
          start: 'top 70%',
          once: true,
          onEnter: () => {
            const crest = root.querySelector('.closing__crest');
            if (!crest) return;
            const r = crest.getBoundingClientRect();
            window.setTimeout(() => particles.burst(r.left + r.width / 2, r.top + r.height / 2, { count: 70, speed: 280, life: 1.8, gravity: -25 }), 450);
          },
        },
      })
      .from('.closing__kicker', { opacity: 0, y: 16, duration: 0.8 })
      .from('.closing__crest-wrap', { opacity: 0, scale: 0.6, rotationY: 90, transformPerspective: 900, duration: 1.4, ease: 'expo.out' }, 0.1)
      .from('.closing__name', { opacity: 0, letterSpacing: '0.5em', duration: 1.6, ease: 'power3.out' }, 0.5)
      .from('.closing__divider, .closing__message, .closing__date', { opacity: 0, y: 18, stagger: 0.15, duration: 0.9 }, 0.9)
      .from('.closing__actions > *', { opacity: 0, y: 14, stagger: 0.1, duration: 0.7 }, 1.3);
  });

  const go = (id: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (scrollToId(id, reducedMotion)) e.preventDefault();
  };

  return (
    <section
      ref={ref}
      id="encerramento"
      className={`closing${CLOSING_LIGHT === 'violet' ? ' closing--violet' : ''}`}
      data-scene="closing"
      aria-labelledby="closing-title"
    >
      <div className="closing__beam" aria-hidden="true" />
      <Candles
        candles={[
          { x: '8%', y: '22%', scale: 0.8, depth: 0.4 },
          { x: '88%', y: '30%', scale: 1, depth: 0.6 },
          { x: '18%', y: '70%', scale: 0.6, depth: 0.3 },
          { x: '80%', y: '76%', scale: 0.7, depth: 0.5 },
        ]}
      />

      <div className="closing__content">
        <p className="closing__kicker kicker">
          {closing.kicker} · {closing.title}
        </p>
        <div className="closing__crest-wrap">
          <div className="closing__halo" aria-hidden="true" />
          <SofiaCrest className="closing__crest" sizes="(max-width: 640px) 11rem, 15rem" />
        </div>
        <h2 id="closing-title" className="closing__name gold-foil" tabIndex={-1} data-focus-target>
          {event.celebrant}
        </h2>
        <Divider className="closing__divider" />
        <p className="closing__message">{closing.message}</p>
        <p className="closing__date">
          <time dateTime={event.date}>
            {parts.day} · {monthNumber} · {parts.year}
          </time>
        </p>

        <nav className="closing__actions" aria-label="Voltar para">
          <a className="btn btn-gold" href="#presenca" onClick={go('presenca')}>
            <Send aria-hidden="true" size={16} />
            Confirmar presença
          </a>
          <a className="btn btn-ghost" href="#presentes" onClick={go('presentes')}>
            <Gift aria-hidden="true" size={16} />
            Lista de presentes
          </a>
          <a className="btn btn-ghost" href="#carta" onClick={go('carta')}>
            <ArrowUp aria-hidden="true" size={16} />
            Reler a carta
          </a>
        </nav>
      </div>

      <footer className="closing__footer">
        <p className="closing__spell">{closing.footerSpell}</p>
        <p>{closing.footerNote}</p>
      </footer>
    </section>
  );
}
