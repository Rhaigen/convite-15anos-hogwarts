import { useRef, type Ref } from 'react';
import { ChevronDown } from 'lucide-react';
import { gsap } from '../../animations/gsap';
import { HogwartsCrest } from '../../components/ui/HogwartsCrest';
import { CornerFlourish, Divider } from '../../components/ui/Ornaments';
import { WaxSeal } from '../../components/ui/WaxSeal';
import { event } from '../../content/event';
import { letter } from '../../content/texts';
import { useGsapScene } from '../../hooks/useGsapScene';
import { formatDateLong, formatTime } from '../../lib/date';
import { scrollToId } from '../../lib/scroll';
import { useEffects } from '../../components/effects/EffectsContext';
import type { RevealMode } from '../OpeningScene/OpeningScene';
import './letter.css';

interface InvitationLetterProps {
  /** Elemento da carta (destino da expansão a partir do envelope). */
  paperRef: Ref<HTMLElement>;
  /** `pending`: ainda coberta pelo envelope. `animate`: revela o texto progressivamente. */
  reveal: RevealMode | 'pending';
}

/** A carta-convite legível, primeira cena da página. */
export function InvitationLetter({ paperRef, reveal }: InvitationLetterProps) {
  const sectionRef = useRef<HTMLElement>(null);
  const { reducedMotion } = useEffects();
  const when = `${formatDateLong(event.date)}${event.time ? `, às ${formatTime(event.time)}` : ''}`;

  useGsapScene(
    sectionRef,
    ({ reducedMotion: reduced }) => {
      if (reveal !== 'animate' || reduced) return;
      const tl = gsap.timeline({ delay: 0.05 });
      tl.from('.letter__crest', { opacity: 0, scale: 0.7, duration: 1.1, ease: 'back.out(1.6)' })
        .from('.letter__head > *', { opacity: 0, y: 16, duration: 0.9, stagger: 0.12 }, '-=0.7')
        .from('[data-line]', { opacity: 0, y: 14, duration: 0.95, stagger: 0.2, ease: 'power2.out' }, '-=0.5')
        .fromTo(
          '.letter__signature',
          { clipPath: 'inset(0 100% 0 0)' },
          { clipPath: 'inset(0 0% 0 0)', duration: 1.6, ease: 'power1.inOut' },
          '-=0.4',
        )
        .from('.letter__stamp', { opacity: 0, scale: 1.6, rotation: -20, duration: 0.7, ease: 'back.out(2)' }, '-=1')
        .from('.letter__continue', { opacity: 0, y: 12, duration: 0.8 }, '-=0.5');
    },
    [reveal],
  );

  return (
    <section ref={sectionRef} id="carta" className="letter-section" data-scene="letter" aria-labelledby="letter-title">
      <article ref={paperRef} className="letter parchment">
        <CornerFlourish className="letter__corner letter__corner--tl" />
        <CornerFlourish className="letter__corner letter__corner--tr" />
        <CornerFlourish className="letter__corner letter__corner--bl" />
        <CornerFlourish className="letter__corner letter__corner--br" />

        <HogwartsCrest className="letter__crest" />
        <header className="letter__head">
          <p className="letter__kicker">Convite</p>
          <h1 id="letter-title" className="letter__title" tabIndex={-1}>
            <span>{event.celebrant}</span>
            <span className="letter__subtitle">celebra seus quinze anos</span>
          </h1>
          <Divider className="letter__divider" />
        </header>

        <div className="letter__body">
          {letter.paragraphs.map((text) => (
            <p key={text} data-line>
              {text}
            </p>
          ))}

          <dl className="letter__details" data-line>
            <div>
              <dt>Data</dt>
              <dd>{when}</dd>
            </div>
            <div>
              <dt>Local</dt>
              <dd>{event.venue}</dd>
            </div>
          </dl>

          <p className="letter__closing" data-line>
            {letter.closingLine}
          </p>
          <p className="letter__signoff" data-line>
            {letter.signOff}
          </p>
          <p className="letter__signature">{letter.signature}</p>
        </div>

        <WaxSeal className="letter__stamp" />
      </article>

      <a
        className="letter__continue"
        href="#travessia"
        onClick={(e) => {
          if (scrollToId('travessia', reducedMotion)) e.preventDefault();
        }}
      >
        <span>{letter.continueLabel}</span>
        <ChevronDown aria-hidden="true" className="letter__continue-icon" />
      </a>
    </section>
  );
}
