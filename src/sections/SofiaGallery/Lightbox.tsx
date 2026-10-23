import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { gallery } from '../../content/texts';
import type { GalleryPhoto } from '../../types/content';
import { GalleryImage } from './GalleryImage';

interface LightboxProps {
  photos: GalleryPhoto[];
  /** Foto aberta; `null` fecha. */
  index: number | null;
  onNavigate: (index: number) => void;
  /** Chamado depois que o diálogo fecha (Esc, botão, clique no fundo). */
  onClose: () => void;
}

/** Deslocamento horizontal mínimo (px) para o gesto de deslizar trocar de foto. */
const SWIPE_MIN = 50;

/**
 * Retrato ampliado num <dialog> nativo: foco preso, Esc fecha e o navegador
 * devolve o foco ao quadro. Setas ←/→, botões e deslizar trocam de foto.
 */
export function Lightbox({ photos, index, onNavigate, onClose }: LightboxProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const count = photos.length;
  const photo = index === null ? null : photos[index];

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (photo && !dialog.open) dialog.showModal();
    if (!photo && dialog.open) dialog.close();
  }, [photo]);

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
      className="lightbox"
      aria-label={gallery.viewer.title}
      onClose={onClose}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        // Clique fora da foto e dos botões fecha.
        if (!(e.target as Element).closest('img, button')) close();
      }}
    >
      {photo && index !== null && (
        <>
          <div className="lightbox__stage" onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
            <figure key={photo.id} className="lightbox__figure">
              <GalleryImage photo={photo} sizes="92vw" className="lightbox__image" />
              {photo.caption && <figcaption className="lightbox__caption">{photo.caption}</figcaption>}
            </figure>
          </div>
          <p className="lightbox__counter" aria-live="polite">
            {index + 1} {gallery.viewer.of} {count}
          </p>
          <button type="button" className="icon-btn lightbox__close" aria-label={gallery.viewer.close} onClick={close}>
            <X aria-hidden="true" size={22} strokeWidth={1.5} />
          </button>
          {count > 1 && (
            <>
              <button type="button" className="icon-btn lightbox__nav lightbox__nav--prev" aria-label={gallery.viewer.previous} onClick={() => step(-1)}>
                <ChevronLeft aria-hidden="true" size={24} strokeWidth={1.5} />
              </button>
              <button type="button" className="icon-btn lightbox__nav lightbox__nav--next" aria-label={gallery.viewer.next} onClick={() => step(1)}>
                <ChevronRight aria-hidden="true" size={24} strokeWidth={1.5} />
              </button>
            </>
          )}
        </>
      )}
    </dialog>
  );
}
