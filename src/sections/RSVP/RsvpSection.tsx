import { useId, useRef } from 'react';
import { MessageCircle, Sparkle, TriangleAlert } from 'lucide-react';
import { RSVP_LIGHT } from '../../animations/ambient';
import { gsap } from '../../animations/gsap';
import { revealHeading } from '../../animations/reveal';
import { ChapterHeading } from '../../components/ui/ChapterHeading';
import { CornerFlourish } from '../../components/ui/Ornaments';
import { rsvpConfig } from '../../content/settings';
import { rsvp as copy } from '../../content/texts';
import { useGsapScene } from '../../hooks/useGsapScene';
import { useInView } from '../../hooks/useInView';
import { formatDateMedium } from '../../lib/date';
import { formatWhatsappNumber, isWhatsappNumber, whatsappUrl } from '../../lib/whatsapp';
import { FlooFlames } from './FlooFlames';
import './rsvp.css';

/**
 * Capítulo VII — confirmação de presença pela Rede de Flu: o cartão leva à conversa
 * com a Professora Aifos no WhatsApp. O site não grava nada; a resposta é registrada
 * pela Aifos, no banco, a partir do número de quem escreve.
 */
export function RsvpSection() {
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref);
  const hintId = useId();
  const number = isWhatsappNumber(rsvpConfig.whatsappNumber) ? rsvpConfig.whatsappNumber : null;
  const url = whatsappUrl(number, copy.greeting);

  useGsapScene(ref, ({ root, reducedMotion }) => {
    if (reducedMotion) return;
    revealHeading(root);
    const tl = gsap.timeline({ scrollTrigger: { trigger: '.rsvp-card', start: 'top 85%', once: true } });
    tl.from('.rsvp-card', { opacity: 0, y: 60, rotationX: 12, transformPerspective: 1400, duration: 1.2, ease: 'power3.out' });
    // As chamas "acendem" quando o cartão chega.
    tl.from('.floo__flames', { opacity: 0, scale: 0.4, transformOrigin: '50% 90%', duration: 0.9, ease: 'back.out(1.6)' }, 0.45);
    tl.from('.floo__reveal', { opacity: 0, y: 14, stagger: 0.08, duration: 0.6, ease: 'power2.out' }, 0.6);
  });

  return (
    <section ref={ref} id="presenca" className="rsvp section-shell" data-scene="rsvp" aria-labelledby="rsvp-title">
      <ChapterHeading
        id="rsvp-title"
        kicker={copy.kicker}
        title={copy.title}
        intro={
          <>
            {copy.intro}
            {rsvpConfig.deadline && (
              <>
                <br />
                {copy.deadline(formatDateMedium(rsvpConfig.deadline))}
              </>
            )}
          </>
        }
      />

      <div className={`rsvp-card parchment floo${RSVP_LIGHT === 'floo' ? ' floo--lit' : ''}${inView ? '' : ' is-idle'}`}>
        <CornerFlourish className="rsvp-card__corner rsvp-card__corner--tl" />
        <CornerFlourish className="rsvp-card__corner rsvp-card__corner--br" />
        {!rsvpConfig.enabled ? (
          <p className="rsvp-card__closed">{copy.disabledMessage}</p>
        ) : (
          <>
            <FlooFlames className="floo__flames" />
            <h3 className="floo__title floo__reveal">{copy.cardTitle}</h3>
            <p className="floo__text floo__reveal">{copy.cardText}</p>
            <ul className="floo__steps floo__reveal">
              {copy.steps.map((step) => (
                <li key={step}>
                  <Sparkle aria-hidden="true" size={15} className="floo__step-icon" />
                  {step}
                </li>
              ))}
            </ul>

            {url && number ? (
              <div className="floo__actions floo__reveal">
                <a className="btn btn-ink floo__button" href={url} target="_blank" rel="noopener noreferrer" aria-describedby={hintId}>
                  <MessageCircle aria-hidden="true" size={18} />
                  {copy.button}
                </a>
                <span id={hintId} className="sr-only">
                  {copy.buttonHint}
                </span>
                <p className="floo__number">
                  {copy.numberLabel} <strong>{formatWhatsappNumber(number)}</strong>
                </p>
              </div>
            ) : (
              <div className="notice notice-pending floo__pending floo__reveal" role="note">
                <TriangleAlert aria-hidden="true" size={18} className="shrink-0" />
                <span>{copy.pending}</span>
              </div>
            )}

            <p className="floo__ai floo__reveal">{copy.aiNote}</p>
          </>
        )}
      </div>
    </section>
  );
}
