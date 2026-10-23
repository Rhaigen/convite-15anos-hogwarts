import { useRef } from 'react';
import { gsap } from '../../animations/gsap';
import { Candles } from '../../components/effects/Candles';
import { GryffindorCrest } from '../../components/ui/GryffindorCrest';
import { Sparkle } from '../../components/ui/Ornaments';
import { event } from '../../content/event';
import { house } from '../../content/texts';
import { useGsapScene } from '../../hooks/useGsapScene';
import { Banner } from './Banner';
import './house.css';

/**
 * Capítulo II — o universo da Grifinória como apresentação da protagonista.
 * Rolagem livre (sem fixação) com parallax em camadas: estandartes, velas,
 * brasão e o nome em folha de ouro surgindo letra a letra.
 */
export function GryffindorWorld() {
  const ref = useRef<HTMLElement>(null);
  const name = event.celebrantFirstName.toUpperCase();

  useGsapScene(ref, ({ root, reducedMotion }) => {
    if (reducedMotion) return;

    // Entrada: estandartes se desenrolam, brasão e nome se materializam.
    const intro = gsap.timeline({
      scrollTrigger: { trigger: '.house__stage', start: 'top 85%', end: 'top 15%', scrub: 0.7 },
    });
    intro
      .from('.banner', { scaleY: 0.35, opacity: 0, duration: 0.6, ease: 'power2.out', stagger: 0.1 }, 0)
      .from('.house__crest-wrap', { scale: 0.55, opacity: 0, rotationY: -55, transformPerspective: 900, duration: 0.6 }, 0.1)
      .from('.house__glow', { scale: 0.4, opacity: 0, duration: 0.6 }, 0.1)
      .from('.house__letter', { yPercent: 70, opacity: 0, rotationX: -80, transformPerspective: 600, stagger: 0.07, duration: 0.45 }, 0.3)
      .from('.house__kicker, .house__surname', { opacity: 0, y: 20, duration: 0.4, stagger: 0.1 }, 0.5)
      .from('.house__tagline', { opacity: 0, y: 24, duration: 0.4 }, 0.65)
      .from('.house__virtues li', { opacity: 0, y: 16, stagger: 0.08, duration: 0.3 }, 0.75);

    // Profundidade: cada camada se move em velocidade diferente.
    const depth = { trigger: root, start: 'top bottom', end: 'bottom top', scrub: true };
    gsap.fromTo('.banner--left', { yPercent: -8 }, { yPercent: 14, ease: 'none', scrollTrigger: depth });
    gsap.fromTo('.banner--right', { yPercent: -4 }, { yPercent: 18, ease: 'none', scrollTrigger: depth });
    gsap.fromTo('.house__content', { y: 60 }, { y: -60, ease: 'none', scrollTrigger: depth });
    root.querySelectorAll<HTMLElement>('.candle').forEach((candle) => {
      const d = Number(candle.dataset.depth ?? 0.5);
      gsap.fromTo(candle, { yPercent: 120 * d }, { yPercent: -160 * d, ease: 'none', scrollTrigger: depth });
    });
  });

  return (
    <section ref={ref} id="grifinoria" className="house" data-scene="house" aria-labelledby="house-title">
      <div className="house__bg" aria-hidden="true">
        <div className="house__drapes" />
        <div className="house__shafts" />
      </div>

      <Candles />

      <div className="house__stage">
        <Banner className="banner--left" />
        <Banner className="banner--right" />

        <div className="house__content">
          <p className="house__kicker kicker">
            {house.kicker} · {house.title}
          </p>
          <div className="house__crest-wrap">
            <div className="house__glow" aria-hidden="true" />
            <GryffindorCrest className="house__crest" title="Brasão da Grifinória" />
          </div>
          <h2 id="house-title" className="house__name" tabIndex={-1} data-focus-target>
            <span className="sr-only">
              {event.celebrantFirstName} — {house.title}
            </span>
            <span className="house__letters" aria-hidden="true">
              {name.split('').map((letter, i) => (
                <span key={i} className="house__letter gold-foil">
                  {letter}
                </span>
              ))}
            </span>
          </h2>
          <p className="house__surname">
            {house.surname} <span aria-hidden="true">·</span> {house.age}
          </p>
          <p className="house__tagline">{house.tagline}</p>
          <ul className="house__virtues" aria-label="Virtudes da casa">
            {house.virtues.map((v) => (
              <li key={v}>
                <Sparkle className="house__virtue-star" />
                {v}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
