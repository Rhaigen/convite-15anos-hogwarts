import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { gsap } from '../../animations/gsap';
import { WaxSeal } from '../../components/ui/WaxSeal';
import { hall as copy } from '../../content/texts';
import type { WallLetter } from '../../lib/messageWall';

/** De onde a carta saiu (para ela voar do Salão até o centro). */
export interface LetterOrigin {
  rect: DOMRect;
  rotate: number;
}

interface LetterDialogProps {
  letters: WallLetter[];
  /** Carta aberta; `null` fecha. */
  index: number | null;
  origin: LetterOrigin | null;
  reducedMotion: boolean;
  onNavigate: (index: number) => void;
  /** Depois que o diálogo fecha (Esc, botão, clique no fundo). */
  onClose: () => void;
}

const SWIPE_MIN = 50;
const SPARKS = 14;

/** Parágrafos separados por linha em branco; quebras simples ficam (white-space: pre-line). */
const paragraphs = (body: string) =>
  body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

/**
 * Carta aberta num <dialog> nativo (foco preso, Esc fecha, o navegador devolve o foco à
 * carta do Salão). Ao abrir: o envelope voa da posição dele até o centro, o selo racha
 * com faíscas, a aba gira, o papel sobe e se desdobra, e o texto aparece linha a linha.
 * Setas ←/→, botões e deslizar trocam de carta. Movimento reduzido: só um fade (CSS).
 */
export function LetterDialog({ letters, index, origin, reducedMotion, onNavigate, onClose }: LetterDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const envRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const timeline = useRef<gsap.core.Timeline | null>(null);
  const closing = useRef(false);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const [swapped, setSwapped] = useState(false);
  const count = letters.length;
  const letter = index === null ? null : (letters[index] ?? null);
  const isOpen = letter !== null;

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (isOpen && !dialog.open) {
      closing.current = false;
      setSwapped(false);
      dialog.showModal();
      // O foco vai para a carta (leitores de tela leem o texto); na coreografia, só quando ela aparece.
      if (reducedMotion) sheetRef.current?.focus({ preventScroll: true });
      else timeline.current = playOpening();
    }
    if (!isOpen && dialog.open) dialog.close();
    // Abre uma vez por carta escolhida no Salão; trocar de carta não repete a abertura.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  function playOpening(): gsap.core.Timeline | null {
    const env = envRef.current;
    const sheet = sheetRef.current;
    if (!env || !sheet) return null;
    const q = gsap.utils.selector(env);
    const envBox = env.getBoundingClientRect();
    const sheetBox = sheet.getBoundingClientRect();
    const from = origin?.rect;
    const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
    // Até a carta aparecer, o foco fica no próprio diálogo (as setas e o Esc continuam valendo).
    ref.current?.focus({ preventScroll: true });

    // 1. O envelope voa do Salão até o centro.
    tl.set(env, { visibility: 'visible' });
    tl.set(sheet, { autoAlpha: 0 });
    tl.from(env, {
      x: from ? from.left + from.width / 2 - (envBox.left + envBox.width / 2) : 0,
      y: from ? from.top + from.height / 2 - (envBox.top + envBox.height / 2) : 60,
      scale: from ? from.width / envBox.width : 0.4,
      rotation: origin?.rotate ?? 0,
      duration: 0.8,
      ease: 'power3.inOut',
    });

    // 2. O selo racha em duas metades, com faíscas.
    tl.addLabel('crack', '+=0.05');
    tl.to(q('.hall-open__half--l'), { x: -26, y: 14, rotation: -32, autoAlpha: 0, duration: 0.6, ease: 'power2.out' }, 'crack');
    tl.to(q('.hall-open__half--r'), { x: 26, y: 16, rotation: 30, autoAlpha: 0, duration: 0.6, ease: 'power2.out' }, 'crack');
    tl.fromTo(
      q('.hall-open__spark'),
      { x: 0, y: 0, scale: 0, autoAlpha: 1 },
      {
        x: () => gsap.utils.random(-110, 110),
        y: () => gsap.utils.random(-100, 50),
        scale: () => gsap.utils.random(0.5, 1.3),
        autoAlpha: 0,
        duration: 0.9,
        ease: 'power2.out',
      },
      'crack',
    );

    // 3. A aba gira para trás.
    tl.to(q('.hall-open__flap'), { rotationX: 180, transformPerspective: 900, duration: 0.6, ease: 'power2.inOut' }, 'crack+=0.2');
    tl.set(q('.hall-open__flap'), { zIndex: 0 }, 'crack+=0.5');

    // 4. O papel sobe de dentro do envelope.
    tl.fromTo(q('.hall-open__paper'), { yPercent: 0 }, { yPercent: -62, duration: 0.55, ease: 'power2.out' }, 'crack+=0.65');

    // 5. O envelope cai e a carta se desdobra no lugar do papel.
    tl.addLabel('unfold', '-=0.1');
    tl.to(env, { y: window.innerHeight * 0.55, rotation: -6, autoAlpha: 0, duration: 0.7, ease: 'power2.in' }, 'unfold');
    tl.fromTo(
      sheet,
      {
        autoAlpha: 0,
        y: envBox.top + envBox.height * 0.05 - (sheetBox.top + sheetBox.height / 2) + (envBox.height * 0.3) / 2,
        scaleX: (envBox.width * 0.82) / sheetBox.width,
        scaleY: 0.3,
        transformOrigin: '50% 50%',
      },
      { autoAlpha: 1, y: 0, scaleX: 1, scaleY: 1, duration: 0.95, ease: 'power3.inOut' },
      'unfold',
    );
    tl.from(sheet.querySelector('.hall-sheet__creases'), { opacity: 1, duration: 0.9, ease: 'power1.out' }, 'unfold+=0.4');

    // 6. O texto aparece linha a linha; a assinatura por último.
    tl.call(() => sheet.focus({ preventScroll: true }), undefined, 'unfold+=0.5');
    tl.from(sheet.querySelectorAll('.hall-sheet__reveal'), { autoAlpha: 0, y: 10, stagger: 0.12, duration: 0.6, ease: 'power2.out' }, 'unfold+=0.75');
    tl.set(env, { visibility: 'hidden' });
    return tl;
  }

  // Trocar de carta remonta a folha: o foco acompanha a nova (senão cairia no <body>).
  useLayoutEffect(() => {
    if (swapped) sheetRef.current?.focus({ preventScroll: true });
  }, [swapped, letter?.id]);

  function finishOpening() {
    timeline.current?.progress(1);
  }

  function requestClose() {
    const dialog = ref.current;
    const scene = sceneRef.current;
    if (!dialog || closing.current) return;
    closing.current = true;
    finishOpening();
    if (reducedMotion || !scene) {
      dialog.close();
      return;
    }
    gsap.to(scene, {
      autoAlpha: 0,
      y: 24,
      scale: 0.97,
      duration: 0.3,
      ease: 'power2.in',
      onComplete: () => dialog.close(),
    });
  }

  // Ao fechar: limpa o que a coreografia deixou nos elementos (a próxima abertura começa do zero).
  useLayoutEffect(() => {
    if (isOpen) return;
    timeline.current?.kill();
    timeline.current = null;
    const env = envRef.current;
    const targets = [sceneRef.current, env, sheetRef.current, ...(env ? Array.from(env.querySelectorAll('*')) : [])].filter(Boolean);
    gsap.set(targets, { clearProps: 'all' });
  }, [isOpen]);

  const step = (delta: number) => {
    if (index === null || count < 2) return;
    finishOpening();
    setSwapped(true);
    onNavigate((index + delta + count) % count);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
    else return;
    e.preventDefault();
  };

  const onPointerDown = (e: PointerEvent) => {
    swipe.current = e.pointerType === 'mouse' ? null : { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: PointerEvent) => {
    const start = swipe.current;
    swipe.current = null;
    if (!start) return;
    const dx = e.clientX - start.x;
    if (Math.abs(dx) >= SWIPE_MIN && Math.abs(dx) > Math.abs(e.clientY - start.y)) step(dx < 0 ? 1 : -1);
  };

  return (
    <dialog
      ref={ref}
      tabIndex={-1}
      className="hall-dialog"
      aria-label={copy.viewer.title}
      onClose={onClose}
      onCancel={(e) => {
        // Esc: fecha com a carta se recolhendo.
        e.preventDefault();
        requestClose();
      }}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        // Clique fora da carta e dos botões fecha.
        if (!(e.target as Element).closest('.hall-sheet, button')) requestClose();
      }}
    >
      {letter && index !== null && (
        <>
          <div ref={sceneRef} className="hall-dialog__scene" onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
            <div ref={envRef} className="hall-open" aria-hidden="true">
              <span className="hall-open__back" />
              <span className="hall-open__paper" />
              <span className="hall-open__pocket" />
              <span className="hall-open__flap" />
              <span className="hall-open__seal">
                <WaxSeal className="hall-open__half hall-open__half--l" />
                <WaxSeal className="hall-open__half hall-open__half--r" />
                {Array.from({ length: SPARKS }, (_, i) => (
                  <span key={i} className="hall-open__spark" />
                ))}
              </span>
            </div>

            <article
              key={letter.id}
              ref={sheetRef}
              className={`hall-sheet parchment${swapped ? ' hall-sheet--swap' : ''}`}
              tabIndex={-1}
              aria-label={copy.letterLabelOpen(letter.from)}
            >
              <span className="hall-sheet__creases" aria-hidden="true" />
              <div className="hall-sheet__scroll">
                <p className="hall-sheet__to hall-sheet__reveal">{copy.to}</p>
                {paragraphs(letter.body ?? '').map((p, i) => (
                  <p key={i} className="hall-sheet__para hall-sheet__reveal">
                    {p}
                  </p>
                ))}
                <p className="hall-sheet__sign hall-sheet__reveal">
                  <span>{copy.signOff}</span>
                  <span className="hall-sheet__from">{letter.from}</span>
                </p>
              </div>
            </article>
          </div>

          <p className="hall-dialog__counter" aria-live="polite">
            {index + 1} {copy.viewer.of} {count}
          </p>
          <button type="button" className="icon-btn hall-dialog__close" aria-label={copy.viewer.close} onClick={requestClose}>
            <X aria-hidden="true" size={22} strokeWidth={1.5} />
          </button>
          {count > 1 && (
            <>
              <button type="button" className="icon-btn hall-dialog__nav hall-dialog__nav--prev" aria-label={copy.viewer.previous} onClick={() => step(-1)}>
                <ChevronLeft aria-hidden="true" size={24} strokeWidth={1.5} />
              </button>
              <button type="button" className="icon-btn hall-dialog__nav hall-dialog__nav--next" aria-label={copy.viewer.next} onClick={() => step(1)}>
                <ChevronRight aria-hidden="true" size={24} strokeWidth={1.5} />
              </button>
            </>
          )}
        </>
      )}
    </dialog>
  );
}
