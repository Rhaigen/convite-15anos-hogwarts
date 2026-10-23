import { useRef } from 'react';
import { CalendarPlus, Clock, ExternalLink, MapPin, Shirt } from 'lucide-react';
import { gsap, ScrollTrigger } from '../../animations/gsap';
import { revealHeading } from '../../animations/reveal';
import { ChapterHeading } from '../../components/ui/ChapterHeading';
import { event } from '../../content/event';
import { details } from '../../content/texts';
import { useGsapScene } from '../../hooks/useGsapScene';
import { downloadIcs, getMapUrl, googleCalendarUrl, toCalendarEntry } from '../../lib/calendar';
import { formatTime, getDateParts } from '../../lib/date';
import { CastlePlan } from './CastlePlan';
import './details.css';

/**
 * Capítulo V — informações práticas em um mapa de pergaminho que se
 * desdobra. Botões de mapa só existem quando há endereço/link real.
 */
export function EventDetails() {
  const ref = useRef<HTMLElement>(null);
  const parts = getDateParts(event.date);
  const entry = toCalendarEntry(event);
  const mapUrl = getMapUrl(event);

  useGsapScene(ref, ({ root, reducedMotion }) => {
    if (reducedMotion) return;
    revealHeading(root);

    const mm = gsap.matchMedia();
    mm.add('(min-width: 900px)', () => {
      gsap
        .timeline({ scrollTrigger: { trigger: '.map', start: 'top 80%', end: 'top 25%', scrub: 0.7 } })
        .from('.map__panel--center', { scale: 0.9, opacity: 0, duration: 0.4 }, 0)
        .from('.map__panel--left', { rotationY: 88, opacity: 0, transformPerspective: 1600, duration: 1, ease: 'power2.out' }, 0.1)
        .from('.map__panel--right', { rotationY: -88, opacity: 0, transformPerspective: 1600, duration: 1, ease: 'power2.out' }, 0.1);
    });
    mm.add('(max-width: 899px)', () => {
      root.querySelectorAll('.map__panel').forEach((panel) => {
        gsap.from(panel, {
          rotationX: -75,
          opacity: 0,
          transformPerspective: 1200,
          transformOrigin: '50% 0%',
          duration: 1.1,
          ease: 'power3.out',
          scrollTrigger: { trigger: panel, start: 'top 88%', once: true },
        });
      });
    });

    // Pegadas surgindo em sequência — só animam enquanto o mapa está visível.
    const steps = gsap.timeline({ repeat: -1, repeatDelay: 0.6, paused: true });
    steps
      .fromTo('.footprint', { opacity: 0 }, { opacity: 0.55, duration: 0.25, stagger: 0.32 })
      .to('.footprint', { opacity: 0, duration: 0.6, stagger: 0.32 }, 1.4);
    ScrollTrigger.create({
      trigger: '.map',
      start: 'top bottom',
      end: 'bottom top',
      onToggle: (self) => (self.isActive ? steps.play() : steps.pause()),
    });

    return () => mm.revert();
  });

  return (
    <section ref={ref} id="celebracao" className="details section-shell" data-scene="details" aria-labelledby="details-title">
      <ChapterHeading id="details-title" kicker={details.kicker} title={details.title} />

      <div className="map">
        <article className="map__panel map__panel--left parchment" aria-labelledby="details-when">
          <h3 id="details-when" className="map__label">
            {details.whenLabel}
          </h3>
          <p className="calendar-page" aria-label={`${parts.weekday}, ${parts.day} de ${parts.month} de ${parts.year}`}>
            <span className="calendar-page__weekday" aria-hidden="true">
              {parts.weekday}
            </span>
            <span className="calendar-page__day" aria-hidden="true">
              {parts.day}
            </span>
            <span className="calendar-page__month" aria-hidden="true">
              {parts.month}
            </span>
            <span className="calendar-page__year" aria-hidden="true">
              {parts.year}
            </span>
          </p>
          <p className="map__line">
            <Clock aria-hidden="true" className="map__icon" />
            {event.time ? <span>Às {formatTime(event.time)}</span> : <span className="map__pending">{details.timePending}</span>}
          </p>
          <div className="map__actions">
            <a className="btn btn-ink" href={googleCalendarUrl(entry)} target="_blank" rel="noopener noreferrer">
              <CalendarPlus aria-hidden="true" size={17} />
              {details.calendarGoogle}
              <span className="sr-only">(abre em nova aba)</span>
            </a>
            <button type="button" className="btn btn-ghost map__btn-ics" onClick={() => downloadIcs(entry)}>
              {details.calendarIcs}
            </button>
          </div>
        </article>

        <div className="map__panel map__panel--center parchment" aria-hidden="true">
          <CastlePlan className="map__plan" name={event.celebrantFirstName} />
          <p className="map__legend">{details.mapLegend}</p>
        </div>

        <article className="map__panel map__panel--right parchment" aria-labelledby="details-where">
          <h3 id="details-where" className="map__label">
            {details.whereLabel}
          </h3>
          {mapUrl ? (
            // Atalho para o mouse/toque; o botão "Abrir no mapa" abaixo é o acesso pelo teclado.
            <a className="map__pin-link" href={mapUrl} target="_blank" rel="noopener noreferrer" title={details.mapPinLabel} tabIndex={-1} aria-hidden="true">
              <MapPin className="map__pin" />
            </a>
          ) : (
            <MapPin aria-hidden="true" className="map__pin" />
          )}
          <p className="map__venue">{event.venue}</p>
          {event.address ? <p className="map__address">{event.address}</p> : <p className="map__address map__pending">{details.addressPending}</p>}
          {event.dressCode && (
            <p className="map__line">
              <Shirt aria-hidden="true" className="map__icon" />
              <span>
                {details.dressCodeLabel}: {event.dressCode}
              </span>
            </p>
          )}
          {mapUrl && (
            <div className="map__actions">
              <a className="btn btn-ink" href={mapUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink aria-hidden="true" size={17} />
                {details.mapButton}
                <span className="sr-only">(abre em nova aba)</span>
              </a>
            </div>
          )}
        </article>
      </div>
    </section>
  );
}
