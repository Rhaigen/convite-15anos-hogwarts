import { useRef } from 'react';
import { Menu, X } from 'lucide-react';
import { chapters } from '../../content/site';
import { scrollToId } from '../../lib/scroll';
import { useEffects } from '../effects/EffectsContext';
import { Divider } from '../ui/Ornaments';

/** Índice de capítulos em um <dialog> nativo (foco preso, Esc fecha). */
export function ChapterMenu() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { reducedMotion } = useEffects();

  const close = () => dialogRef.current?.close();

  return (
    <>
      <button
        type="button"
        className="icon-btn"
        aria-haspopup="dialog"
        aria-label="Abrir índice de capítulos"
        onClick={() => dialogRef.current?.showModal()}
      >
        <Menu aria-hidden="true" size={20} strokeWidth={1.5} />
      </button>

      <dialog
        ref={dialogRef}
        className="chapter-menu"
        aria-labelledby="chapter-menu-title"
        onClick={(e) => {
          // Clique no fundo escurecido fecha o índice.
          if (e.target === dialogRef.current) close();
        }}
      >
        <div className="chapter-menu__panel">
          <div className="chapter-menu__head">
            <p id="chapter-menu-title" className="kicker">
              Índice mágico
            </p>
            <button type="button" className="icon-btn" aria-label="Fechar índice" onClick={close}>
              <X aria-hidden="true" size={20} strokeWidth={1.5} />
            </button>
          </div>
          <Divider className="chapter-menu__divider" />
          <nav aria-label="Capítulos do convite">
            <ol className="chapter-menu__list">
              {chapters.map((c) => (
                <li key={c.id}>
                  <a
                    href={`#${c.id}`}
                    onClick={(e) => {
                      close();
                      if (scrollToId(c.id, reducedMotion)) e.preventDefault();
                    }}
                  >
                    <span className="chapter-menu__numeral" aria-hidden="true">
                      {c.numeral}
                    </span>
                    <span>{c.label}</span>
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        </div>
      </dialog>
    </>
  );
}
