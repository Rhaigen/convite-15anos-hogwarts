import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { Feather } from 'lucide-react';
import { gsap, ScrollTrigger } from '../../animations/gsap';
import { revealHeading } from '../../animations/reveal';
import { Candles } from '../../components/effects/Candles';
import { useEffects } from '../../components/effects/EffectsContext';
import { ChapterHeading } from '../../components/ui/ChapterHeading';
import { rsvpConfig } from '../../content/settings';
import { hall as copy, rsvp } from '../../content/texts';
import { useGsapScene } from '../../hooks/useGsapScene';
import { useInView } from '../../hooks/useInView';
import { demoWall, fetchWall, loadReadLetters, saveReadLetters, wallDemoParam, wallEndpoint, type Wall } from '../../lib/messageWall';
import { particles } from '../../lib/particles';
import { isWhatsappNumber, whatsappUrl } from '../../lib/whatsapp';
import { FloatingLetter } from './FloatingLetter';
import { hallColumns, layoutHall } from './hallLayout';
import { LetterDialog, type LetterOrigin } from './LetterDialog';
import './great-hall.css';

type LoadState = { status: 'idle' | 'loading' | 'off' } | { status: 'ready'; wall: Wall };

const unsealFormat = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Sao_Paulo' });

/** Lê `--colw` em px a partir da largura do campo (as cartas nunca encostam umas nas outras). */
function useFieldColumns(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ columns: 2, width: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const width = el.clientWidth;
      const columns = hallColumns(width);
      setSize((s) => (s.columns === columns && Math.abs(s.width - width) < 1 ? s : { columns, width }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/**
 * Capítulo IX — O Salão Principal: os recados dos convidados, aprovados pela família,
 * flutuam como cartas presas a velas sob o teto encantado. Até o dia da festa ficam
 * selados (o texto nem chega ao navegador); depois, cada carta abre ao toque.
 * O site só LÊ as cartas (função pública site-messages); quem guarda é a Professora Aifos.
 */
export function GreatHall() {
  const ref = useRef<HTMLElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const { reducedMotion } = useEffects();
  const inView = useInView(ref);
  const near = useInView(ref, '1500px 0px');
  const [state, setState] = useState<LoadState>({ status: 'idle' });
  const [read, setRead] = useState<Set<string>>(() => new Set());
  const [open, setOpen] = useState<{ index: number; origin: LetterOrigin | null } | null>(null);
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef(0);
  const { columns, width } = useFieldColumns(fieldRef);

  const number = isWhatsappNumber(rsvpConfig.whatsappNumber) ? rsvpConfig.whatsappNumber : null;
  const writeUrl = rsvpConfig.enabled ? whatsappUrl(number, rsvp.messageGreeting) : null;

  // Busca as cartas uma vez, quando o capítulo se aproxima.
  useEffect(() => {
    if (!near || state.status !== 'idle') return;
    const demo = wallDemoParam();
    const url = wallEndpoint();
    if (!demo && !url) {
      setState({ status: 'off' });
      return;
    }
    setState({ status: 'loading' });
    setRead(loadReadLetters());
    const abort = new AbortController();
    (import.meta.env.DEV && demo ? demoWall(demo) : fetchWall(url!, abort.signal))
      .then((wall) => setState({ status: 'ready', wall }))
      .catch(() => {
        // Sem cartas (função fora do ar, rede): o capítulo fica só com o convite para escrever.
        if (!abort.signal.aborted) setState({ status: 'off' });
      });
    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near]);

  const wall = state.status === 'ready' ? state.wall : null;
  const letters = useMemo(() => wall?.letters ?? [], [wall]);
  const layout = useMemo(() => layoutHall(letters.length, columns), [letters.length, columns]);
  const unsealDate = wall?.unsealAt ? unsealFormat.format(wall.unsealAt) : null;
  const sealed = wall?.sealed ?? true;

  // Cartas novas mudam a altura da página: recalcula os gatilhos dos capítulos seguintes.
  useLayoutEffect(() => {
    ScrollTrigger.refresh();
  }, [layout.rows, width]);

  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  useGsapScene(
    ref,
    ({ root, reducedMotion: reduced }) => {
      if (reduced) return;
      revealHeading(root);
      gsap.from('.hall__status, .hall__cta', {
        opacity: 0,
        y: 18,
        stagger: 0.12,
        duration: 0.9,
        ease: 'power2.out',
        scrollTrigger: { trigger: '.hall__status', start: 'top 88%', once: true },
      });
      if (letters.length === 0) return;

      // Chegada das corujas: as cartas descem do alto, fileira a fileira, conforme entram na tela.
      ScrollTrigger.batch('.hall-letter', {
        start: 'top 95%',
        once: true,
        onEnter: (batch) =>
          gsap.from(
            batch.map((el) => el.querySelector('.hall-letter__arrive')),
            {
              y: () => -gsap.utils.random(180, 320),
              x: () => gsap.utils.random(-60, 60),
              rotation: () => gsap.utils.random(-28, 28),
              opacity: 0,
              duration: 1.5,
              ease: 'power3.out',
              stagger: { each: 0.08, from: 'random' },
            },
          ),
      });

      // Profundidade: as do fundo descem um pouco, as da frente sobem.
      const field = root.querySelector('.hall__field');
      for (const [depth, y] of [
        [0, 18],
        [2, -24],
      ] as const) {
        gsap.to(`.hall-letter--d${depth}`, {
          y,
          ease: 'none',
          scrollTrigger: { trigger: field, start: 'top bottom', end: 'bottom top', scrub: 0.6 },
        });
      }
    },
    [letters.length, columns],
  );

  const announce = (text: string) => {
    window.clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = window.setTimeout(() => setNotice(''), 4200);
  };

  const onActivate = useCallback(
    (index: number, button: HTMLButtonElement) => {
      const letter = letters[index];
      if (!letter) return;
      const env = button.querySelector<HTMLElement>('.hall-letter__env');
      if (sealed || !letter.body) {
        // Selada: a carta treme, o selo brilha e a magia resiste (faíscas).
        announce(copy.sealedTap(letter.from, unsealDate ?? ''));
        if (!reducedMotion && env) {
          gsap.fromTo(env, { rotation: 0 }, { keyframes: { rotation: [-7, 6, -4, 3, -1, 0] }, duration: 0.6, ease: 'none', overwrite: true });
          button.classList.remove('is-pulsing');
          void button.offsetWidth;
          button.classList.add('is-pulsing');
          const seal = button.querySelector('.hall-letter__seal')?.getBoundingClientRect();
          if (seal) particles.burst(seal.left + seal.width / 2, seal.top + seal.height / 2, { count: 18, speed: 140, life: 0.9, gravity: -20 });
        }
        return;
      }
      const slot = layout.slots[index];
      setOpen({ index, origin: env ? { rect: env.getBoundingClientRect(), rotate: slot?.rotate ?? 0 } : null });
    },
    [letters, sealed, unsealDate, reducedMotion, layout],
  );

  // Carta aberta = carta lida (selo partido no Salão, lembrado neste navegador).
  useEffect(() => {
    const id = open ? letters[open.index]?.id : undefined;
    if (!id || read.has(id)) return;
    const next = new Set(read).add(id);
    setRead(next);
    saveReadLetters(next);
  }, [open, letters, read]);

  const label = (from: string, id: string) =>
    sealed ? copy.letterLabelSealed(from, unsealDate ?? '') : read.has(id) ? copy.letterLabelRead(from) : copy.letterLabelOpen(from);

  const status =
    state.status === 'idle' || state.status === 'loading'
      ? { text: copy.loading, note: null }
      : !wall || letters.length === 0
        ? { text: copy.empty, note: null }
        : sealed
          ? { text: copy.countSealed(letters.length), note: unsealDate ? copy.sealedNote(unsealDate) : null }
          : { text: copy.countOpen(letters.length), note: copy.openNote };

  return (
    <section
      ref={ref}
      id="salao"
      className={`hall section-shell${inView ? '' : ' is-idle'}${sealed ? ' is-sealed' : ''}`}
      data-scene="hall"
      aria-labelledby="hall-title"
    >
      <div className="hall__sky" aria-hidden="true">
        <span className="hall__stars hall__stars--far" />
        <span className="hall__stars hall__stars--mid" />
        <span className="hall__stars hall__stars--near" />
      </div>
      <Candles
        candles={[
          { x: '6%', y: '10%', scale: 0.7, depth: 0.3 },
          { x: '92%', y: '16%', scale: 0.9, depth: 0.5 },
          { x: '14%', y: '58%', scale: 0.55, depth: 0.25 },
          { x: '86%', y: '64%', scale: 0.65, depth: 0.4 },
        ]}
      />

      <ChapterHeading id="hall-title" kicker={copy.kicker} title={copy.title} intro={copy.intro} />

      <div className="hall__status" aria-live="polite">
        <p className="hall__count">{status.text}</p>
        {status.note && <p className="hall__note">{status.note}</p>}
      </div>

      <div
        ref={fieldRef}
        className="hall__field"
        style={{ '--rows': layout.rows.toFixed(4), '--colw': `${width / columns}px` } as CSSProperties}
      >
        {letters.map((letter, i) => (
          <FloatingLetter
            key={letter.id}
            letter={letter}
            slot={layout.slots[i]!}
            index={i}
            label={label(letter.from, letter.id)}
            read={!sealed && read.has(letter.id)}
            onActivate={onActivate}
          />
        ))}
      </div>

      <p className="hall__notice" role="status">
        {notice && <span key={notice}>{notice}</span>}
      </p>

      {writeUrl && (
        <div className="hall__cta">
          <p className="hall__cta-title">
            <Feather aria-hidden="true" size={17} />
            {copy.ctaTitle}
          </p>
          <p className="hall__cta-text">{copy.ctaText}</p>
          <a className="btn btn-gold" href={writeUrl} target="_blank" rel="noopener noreferrer">
            {copy.ctaButton}
          </a>
        </div>
      )}

      {!sealed && (
        <LetterDialog
          letters={letters}
          index={open?.index ?? null}
          origin={open?.origin ?? null}
          reducedMotion={reducedMotion}
          onNavigate={(index) => setOpen({ index, origin: null })}
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
}
