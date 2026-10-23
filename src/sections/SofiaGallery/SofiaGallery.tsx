import { useRef, useState, type CSSProperties, type FocusEvent } from 'react';
import { gsap, ScrollTrigger } from '../../animations/gsap';
import { revealHeading } from '../../animations/reveal';
import { ChapterHeading } from '../../components/ui/ChapterHeading';
import { galleryPhotos } from '../../content/gallery';
import { gallery } from '../../content/texts';
import { useGsapScene } from '../../hooks/useGsapScene';
import { scrollToY } from '../../lib/scroll';
import { Lightbox } from './Lightbox';
import { focusAt, framePose, FRONT_RANGE, MAX_SHADE, progressFor, towerMetrics, type TowerMetrics } from './spiral';
import { createTowerCanvas } from './towerCanvas';
import { TowerFrame } from './TowerFrame';
import './gallery.css';

/** Espaço (px) que sobra entre a introdução e o primeiro quadro, além do respiro da introdução. */
const LIFT_GAP = 16;

/** Controle da torre montada (ausente no movimento reduzido / coluna estática). */
interface TowerControl {
  /** O quadro está (ou a rolagem já o levou) na frente? */
  isFront: (index: number) => boolean;
  /** Gira a torre, rolando a página, até o quadro chegar à frente. */
  bringToFront: (index: number) => void;
}

/**
 * Capítulo III — torre espiral de retratos. Os quadros giram em volta de um
 * eixo invisível e sobem conforme a rolagem (descer avança, subir retrocede).
 * Tocar no quadro da frente amplia a foto; tocar (ou focar com Tab) em outro
 * gira a torre até ele. Sem JS ou com movimento reduzido, fica uma coluna de
 * quadros emoldurados (tocar amplia).
 */
export function SofiaGallery() {
  const ref = useRef<HTMLElement>(null);
  const control = useRef<TowerControl | null>(null);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const count = galleryPhotos.length;

  useGsapScene(ref, ({ root, reducedMotion, quality }) => {
    if (reducedMotion) return;
    revealHeading(root);

    const tower = root.querySelector<HTMLElement>('.tower');
    const stage = root.querySelector<HTMLElement>('.tower__stage');
    const frames = Array.from(root.querySelectorAll<HTMLElement>('.tower-frame'));
    if (!tower || !stage || frames.length === 0) return;
    const shades = frames.map((el) => el.querySelector<HTMLElement>('.tower-frame__shade'));
    // Opacidade nas faces: no quadro (preserve-3d) ela achataria frente e verso num plano só.
    const faces = frames.map((el) => Array.from(el.querySelectorAll<HTMLElement>('.tower-frame__front, .tower-frame__back')));

    tower.classList.add('is-tower');
    const state = { focus: 0 };
    let metrics: TowerMetrics;

    const canvas = root.querySelector<HTMLCanvasElement>('.tower__canvas');
    const magic = canvas
      ? createTowerCanvas({ canvas, target: tower, count: frames.length, quality, getFocus: () => state.focus })
      : null;

    const measure = () => {
      metrics = towerMetrics(stage.clientWidth, stage.clientHeight);
      stage.style.setProperty('--tower-vw', `${metrics.verticalWidth}px`);
      stage.style.setProperty('--tower-hw', `${metrics.horizontalWidth}px`);
      stage.style.setProperty('--tower-perspective', `${metrics.perspective}px`);
      magic?.resize(stage.clientWidth, stage.clientHeight, metrics);
    };

    // Só transform/opacity a cada quadro de rolagem. Os quadros distantes ficam
    // transparentes e estacionados no centro, atrás do eixo (não com
    // `visibility: hidden`, que os tiraria da ordem do Tab e dos leitores de
    // tela; no centro do palco o foco não faz o navegador rolar a página).
    // `written` guarda o último valor de cada quadro: o estilo só é tocado quando
    // muda (os distantes, parados, não custam nada na rolagem).
    const written = frames.map(() => ({ transform: '', opacity: '', shade: '' }));
    const render = () => {
      frames.forEach((el, i) => {
        const pose = framePose(i, state.focus, metrics);
        const last = written[i]!;
        const transform = pose.visible
          ? `translate(-50%, -50%) translate3d(${pose.x.toFixed(1)}px, ${pose.y.toFixed(1)}px, ${pose.z.toFixed(1)}px) rotateY(${pose.rotY.toFixed(2)}deg)`
          : `translate(-50%, -50%) translate3d(0px, 0px, ${-2 * metrics.radius}px)`;
        const opacity = pose.visible ? pose.opacity.toFixed(3) : '0';
        const shade = pose.visible ? (pose.shade * MAX_SHADE).toFixed(3) : last.shade;
        if (transform !== last.transform) el.style.transform = last.transform = transform;
        if (opacity !== last.opacity) {
          last.opacity = opacity;
          faces[i]?.forEach((face) => (face.style.opacity = opacity));
        }
        if (shade !== last.shade) {
          last.shade = shade;
          const layer = shades[i];
          if (layer) layer.style.opacity = shade;
        }
        el.classList.toggle('is-far', !pose.visible);
        el.classList.toggle('is-front', pose.visible && pose.front);
      });
    };

    // O primeiro quadro fica no meio do palco (100% da tela): sem compensação,
    // sobraria meia tela vazia entre a introdução e ele. A torre sobe por baixo
    // da introdução até restar só LIFT_GAP. Recalculado antes de cada refresh
    // do ScrollTrigger (que então mede a torre já na posição final).
    const lift = () => {
      measure();
      const empty = (stage.clientHeight - (frames[0]?.offsetHeight ?? 0)) / 2;
      tower.style.marginTop = `${-Math.max(0, Math.round(empty - LIFT_GAP))}px`;
    };
    ScrollTrigger.addEventListener('refreshInit', lift);
    lift();
    render();

    const tween = gsap.to(state, {
      focus: frames.length - 1,
      ease: 'none',
      onUpdate: render,
      scrollTrigger: {
        trigger: tower,
        start: 'top top',
        end: 'bottom bottom',
        scrub: 0.5,
        onRefresh: () => {
          measure();
          render();
        },
      },
    });
    const trigger = tween.scrollTrigger;

    if (trigger) {
      control.current = {
        isFront: (i) => Math.abs(i - focusAt(trigger.progress, frames.length)) < FRONT_RANGE,
        bringToFront: (i) => {
          const y = trigger.start + progressFor(i, frames.length) * (trigger.end - trigger.start);
          if (Math.abs(y - window.scrollY) < 2) return;
          const distance = Math.abs(i - focusAt(trigger.progress, frames.length));
          scrollToY(y, Math.min(1.8, 0.6 + 0.25 * distance), false);
        },
      };
    }

    // Retratos que se movem: as animações CSS dos quadros param fora da tela.
    const idle = new IntersectionObserver((entries) => tower.classList.toggle('is-idle', !entries.at(-1)?.isIntersecting));
    idle.observe(tower);

    return () => {
      control.current = null;
      ScrollTrigger.removeEventListener('refreshInit', lift);
      tower.style.removeProperty('margin-top');
      idle.disconnect();
      magic?.destroy();
      tower.classList.remove('is-tower', 'is-idle');
      ['--tower-vw', '--tower-hw', '--tower-perspective'].forEach((p) => stage.style.removeProperty(p));
      frames.forEach((el, i) => {
        el.style.removeProperty('transform');
        faces[i]?.forEach((face) => face.style.removeProperty('opacity'));
        el.classList.remove('is-front', 'is-far');
        shades[i]?.style.removeProperty('opacity');
      });
    };
  });

  const frameButton = (i: number) => ref.current?.querySelectorAll<HTMLElement>('.tower-frame__front')[i];

  // Quadro da frente (ou coluna estática) amplia; outro quadro gira a torre até ele.
  // "Da frente" é o que a tela mostra (com o selo "Ampliar") ou o que a rolagem já
  // alcançou: a torre segue a rolagem com atraso, e o toque deve valer pelo que se vê.
  const activate = (i: number) => {
    const tower = control.current;
    const shown = frameButton(i)?.closest('.tower-frame')?.classList.contains('is-front');
    if (tower && !shown && !tower.isFront(i)) tower.bringToFront(i);
    else setOpenIndex(i);
  };

  // Tab até um quadro o traz para a frente (o clique do mouse é tratado em `activate`).
  const focusFrame = (i: number, e: FocusEvent<HTMLButtonElement>) => {
    if (e.currentTarget.matches(':focus-visible')) control.current?.bringToFront(i);
  };

  // Ao fechar, o foco volta para o quadro da última foto vista e a torre gira até ele.
  const closeViewer = () => {
    const last = openIndex;
    setOpenIndex(null);
    if (last === null) return;
    const button = frameButton(last);
    button?.focus({ preventScroll: true });
    if (control.current) control.current.bringToFront(last);
    else button?.scrollIntoView({ block: 'center' });
  };

  return (
    <section ref={ref} id="retratos" className="gallery" data-scene="gallery" aria-labelledby="gallery-title">
      <div className="gallery__intro">
        <ChapterHeading id="gallery-title" kicker={gallery.kicker} title={gallery.title} intro={gallery.intro} />
      </div>
      {count === 0 ? (
        <p className="gallery__empty notice notice-dark">As fotografias serão adicionadas em breve.</p>
      ) : (
        <div className="tower" style={{ '--count': count } as CSSProperties}>
          <div className="tower__stage">
            <canvas className="tower__canvas" aria-hidden="true" />
            <ol className="tower__frames">
              {galleryPhotos.map((photo, i) => (
                <TowerFrame key={photo.id} photo={photo} index={i} onActivate={activate} onFocusFrame={focusFrame} />
              ))}
            </ol>
          </div>
        </div>
      )}
      <Lightbox photos={galleryPhotos} index={openIndex} onNavigate={setOpenIndex} onClose={closeViewer} />
    </section>
  );
}
