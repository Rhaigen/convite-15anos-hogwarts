import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { gsap } from '../../animations/gsap';
import { createOpeningSequence, type OpeningSequence } from '../../animations/openingTimeline';
import { Envelope } from '../../components/invitation/Envelope';
import { useEffects } from '../../components/effects/EffectsContext';
import { HogwartsCrest } from '../../components/ui/HogwartsCrest';
import { Sparkle } from '../../components/ui/Ornaments';
import { Volume2 } from 'lucide-react';
import { useGsapScene } from '../../hooks/useGsapScene';
import { audioConfig } from '../../content/settings';
import { letter } from '../../content/texts';
import './opening.css';

export type RevealMode = 'animate' | 'static';

interface OpeningSceneProps {
  /** Carta real (no fluxo da página) — destino da expansão. */
  letterTarget: RefObject<HTMLElement | null>;
  onReveal: (mode: RevealMode) => void;
  onComplete: () => void;
}

type OpeningState = 'ready' | 'opening';

/**
 * Cena de abertura em tela cheia: o envelope flutuante com selo de cera.
 * Estados: pronta → abrindo (pode ser pulada) → concluída (desmontada).
 */
export function OpeningScene({ letterTarget, onReveal, onComplete }: OpeningSceneProps) {
  const rootRef = useRef<HTMLElement>(null);
  const tiltRef = useRef<HTMLSpanElement>(null);
  const envelopeRef = useRef<HTMLSpanElement>(null);
  const headingRef = useRef<HTMLElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);
  const haloRef = useRef<HTMLDivElement>(null);
  const flashRef = useRef<HTMLDivElement>(null);
  const flyRef = useRef<HTMLDivElement>(null);
  const sequenceRef = useRef<OpeningSequence | null>(null);
  const [state, setState] = useState<OpeningState>('ready');
  const { reducedMotion, finePointer } = useEffects();

  // Entrada da cena e flutuação ociosa do envelope.
  useGsapScene(rootRef, ({ reducedMotion: reduced }) => {
    if (reduced) return;
    gsap.from('.opening__heading > *', { opacity: 0, y: 18, duration: 1.3, stagger: 0.14, delay: 0.15, ease: 'power3.out' });
    gsap.from('.opening__envelope-float', {
      opacity: 0,
      yPercent: 18,
      rotationX: 24,
      scale: 0.9,
      transformPerspective: 1200,
      duration: 1.8,
      delay: 0.1,
      ease: 'power3.out',
    });
    gsap.from('.opening__cues > *', { opacity: 0, y: 10, duration: 1.1, stagger: 0.25, delay: 1.2 });
    gsap.to('.opening__envelope-bob', { yPercent: -2.4, duration: 2.8, ease: 'sine.inOut', yoyo: true, repeat: -1 });
  });

  // Inclinação sutil do envelope seguindo o ponteiro (somente mouse).
  useEffect(() => {
    const tilt = tiltRef.current;
    if (!tilt || reducedMotion || !finePointer || state !== 'ready') return;
    gsap.set(tilt, { transformPerspective: 1200 });
    const rx = gsap.quickTo(tilt, 'rotationX', { duration: 0.9, ease: 'power3.out' });
    const ry = gsap.quickTo(tilt, 'rotationY', { duration: 0.9, ease: 'power3.out' });
    const onMove = (e: PointerEvent) => {
      const nx = e.clientX / window.innerWidth - 0.5;
      const ny = e.clientY / window.innerHeight - 0.5;
      ry(nx * 12);
      rx(-ny * 9);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [reducedMotion, finePointer, state]);

  const finishStatic = useCallback(() => {
    sequenceRef.current?.kill();
    onReveal('static');
    onComplete();
  }, [onComplete, onReveal]);

  const open = useCallback(() => {
    if (state === 'opening') {
      // Segundo toque durante a animação: pular direto para a carta.
      finishStatic();
      return;
    }
    setState('opening');
    const target = letterTarget.current;
    const parts = {
      overlay: rootRef.current,
      envelope: envelopeRef.current,
      tilt: tiltRef.current,
      heading: headingRef.current,
      hint: hintRef.current,
      halo: haloRef.current,
      flash: flashRef.current,
      fly: flyRef.current,
    };

    if (reducedMotion || !target || Object.values(parts).some((p) => p === null)) {
      // Movimento reduzido: revelação curta e estática, sem 3D nem partículas.
      onReveal('static');
      gsap.to(rootRef.current, { opacity: 0, duration: reducedMotion ? 0.3 : 0, onComplete });
      return;
    }

    try {
      sequenceRef.current = createOpeningSequence(parts as Record<keyof typeof parts, HTMLElement>, target, {
        onReveal: () => onReveal('animate'),
        onComplete,
      });
    } catch (error) {
      console.error(error);
      finishStatic();
    }
  }, [finishStatic, letterTarget, onComplete, onReveal, reducedMotion, state]);

  // Esc pula a animação; a sequência é sempre encerrada ao desmontar.
  useEffect(() => {
    if (state !== 'opening') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finishStatic();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [finishStatic, state]);

  useEffect(() => () => sequenceRef.current?.kill(), []);

  return (
    <section ref={rootRef} className="opening" aria-labelledby="opening-title" data-state={state}>
      <div className="opening__rays" aria-hidden="true" />
      <div ref={haloRef} className="opening__halo" aria-hidden="true" />
      <div className="opening__mist" aria-hidden="true" />

      <header ref={headingRef} className="opening__heading">
        <p className="kicker">XV · MMXXVII</p>
        <h2 id="opening-title">{letter.envelopeHeading}</h2>
      </header>

      <div className="opening__stage">
        <button
          type="button"
          className="opening__envelope-btn"
          onClick={open}
          aria-describedby="opening-hint"
          aria-label={state === 'ready' ? 'Abrir a carta de convite' : 'Pular animação e ler a carta'}
        >
          <span className="opening__envelope-float">
            <span className="opening__envelope-bob">
              <span ref={tiltRef} className="opening__envelope-tilt">
                <span ref={envelopeRef} className="opening__envelope">
                  <Envelope address={letter.envelopeAddress} />
                </span>
              </span>
            </span>
          </span>
        </button>
      </div>

      <div ref={hintRef} className="opening__cues">
        <p id="opening-hint" className="opening__hint">
          <Sparkle className="opening__hint-star" />
          <span>{letter.openHint}</span>
          <Sparkle className="opening__hint-star" />
        </p>
        {/* A música começa no toque do envelope: o aviso chega antes dele. */}
        {audioConfig.src && (
          <p className="opening__sound">
            <Volume2 aria-hidden="true" size={16} strokeWidth={1.6} />
            {letter.soundHint}
          </p>
        )}
      </div>

      <div ref={flashRef} className="opening__flash" aria-hidden="true" />
      <div ref={flyRef} className="opening__fly parchment" aria-hidden="true">
        <div className="opening__fly-content" data-fly-content>
          <HogwartsCrest className="opening__fly-crest" />
          <span className="opening__fly-kicker">Convite</span>
        </div>
      </div>
    </section>
  );
}
