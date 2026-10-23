import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { profetaTexts } from '../content/profeta';
import type { ProfetaItem } from '../lib/profeta';
import { credit } from './Edition';

const t = profetaTexts.viewer;
const SWIPE_MIN = 50;

interface ViewerProps {
  items: ProfetaItem[];
  index: number | null;
  onNavigate: (index: number) => void;
  onClose: () => void;
}

/**
 * Fotografia ampliada (ou vídeo com som e controles) num <dialog> nativo, como a galeria do
 * convite: foco preso, Esc fecha, setas e deslizar trocam.
 */
export function Viewer({ items, index, onNavigate, onClose }: ViewerProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const item = index === null ? null : (items[index] ?? null);
  const count = items.length;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (item && !dialog.open) dialog.showModal();
    if (!item && dialog.open) dialog.close();
  }, [item]);

  const close = () => ref.current?.close();
  const step = (delta: number) => {
    if (index !== null && count > 1) onNavigate((index + delta + count) % count);
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
      className="profeta-viewer"
      aria-label={item ? credit(item) : profetaTexts.masthead}
      onClose={onClose}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        if (!(e.target as Element).closest('img, video, button')) close();
      }}
    >
      {item && index !== null && (
        <>
          <div className="profeta-viewer__stage" onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
            <figure key={item.n} className="profeta-viewer__figure">
              {item.tipo === 'video' && item.video ? (
                <video src={item.video} poster={item.mini} controls autoPlay playsInline loop className="profeta-viewer__media" />
              ) : (
                <img src={item.grande ?? item.mini} alt={item.legenda ?? ''} className="profeta-viewer__media" />
              )}
              <figcaption className="profeta-viewer__caption">
                <span>{credit(item)}</span>
                {item.legenda && <em>{item.legenda}</em>}
              </figcaption>
            </figure>
          </div>
          <p className="profeta-viewer__counter" aria-live="polite">
            {index + 1} {t.of} {count}
          </p>
          <button type="button" className="profeta-icon-btn profeta-viewer__close" aria-label={t.close} onClick={close}>
            <X aria-hidden="true" size={22} strokeWidth={1.5} />
          </button>
          {count > 1 && (
            <>
              <button type="button" className="profeta-icon-btn profeta-viewer__nav profeta-viewer__nav--prev" aria-label={t.previous} onClick={() => step(-1)}>
                <ChevronLeft aria-hidden="true" size={24} strokeWidth={1.5} />
              </button>
              <button type="button" className="profeta-icon-btn profeta-viewer__nav profeta-viewer__nav--next" aria-label={t.next} onClick={() => step(1)}>
                <ChevronRight aria-hidden="true" size={24} strokeWidth={1.5} />
              </button>
            </>
          )}
        </>
      )}
    </dialog>
  );
}
