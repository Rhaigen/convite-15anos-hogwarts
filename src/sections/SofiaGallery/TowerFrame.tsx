import type { CSSProperties, FocusEvent } from 'react';
import { gallery } from '../../content/texts';
import type { GalleryPhoto } from '../../types/content';
import { frameArt } from './frames';
import { GalleryImage } from './GalleryImage';

interface TowerFrameProps {
  photo: GalleryPhoto;
  index: number;
  /** Clique/Enter no quadro (ou no verso dele). */
  onActivate: (index: number) => void;
  /** Foco por teclado no quadro. */
  onFocusFrame: (index: number, event: FocusEvent<HTMLButtonElement>) => void;
}

/**
 * Um quadro da torre: a foto na abertura, a moldura por cima, uma sombra com
 * a silhueta da moldura (profundidade) e, atrás, o verso escurecido
 * (visível quando o quadro gira para o fundo da espiral). A frente é um
 * botão (só conteúdo inline: spans e a <picture>).
 */
export function TowerFrame({ photo, index, onActivate, onFocusFrame }: TowerFrameProps) {
  const orient = photo.height > photo.width ? 'v' : 'h';
  const art = frameArt[orient];
  const style = {
    '--i': index,
    '--frame-ratio': art.ratio,
    '--frame-art': `url("${art.src}")`,
    '--win-top': `${art.window.top}%`,
    '--win-right': `${art.window.right}%`,
    '--win-bottom': `${art.window.bottom}%`,
    '--win-left': `${art.window.left}%`,
  } as CSSProperties;
  const frameImg = (className: string) => (
    <img className={className} src={art.src} srcSet={art.srcSet} sizes="(min-width: 700px) 36rem, 86vw" alt="" loading="lazy" decoding="async" />
  );

  return (
    <li className="tower-frame" data-orient={orient} style={style} onClick={() => onActivate(index)}>
      <button
        type="button"
        className="tower-frame__front"
        aria-haspopup="dialog"
        aria-label={`${gallery.viewer.open}: ${photo.alt}`}
        onFocus={(e) => onFocusFrame(index, e)}
      >
        <span className="tower-frame__window">
          <GalleryImage photo={photo} sizes="(min-width: 700px) 28rem, 70vw" />
          <span className="tower-frame__glint" aria-hidden="true" />
        </span>
        {frameImg('tower-frame__art')}
        <span className="tower-frame__art-glint" aria-hidden="true">
          <span className="tower-frame__glint" />
        </span>
        <span className="tower-frame__zoom" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="M15.5 15.5 21 21M10.5 7.5v6M7.5 10.5h6" />
          </svg>
          {gallery.viewer.hint}
        </span>
        <span className="tower-frame__shade" aria-hidden="true">
          <span className="tower-frame__shade-window" />
          {frameImg('tower-frame__art tower-frame__art--shade')}
        </span>
      </button>
      <div className="tower-frame__back" aria-hidden="true">
        <span className="tower-frame__board" />
        {frameImg('tower-frame__art tower-frame__art--back')}
      </div>
    </li>
  );
}
