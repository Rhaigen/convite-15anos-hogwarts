import { useState, type CSSProperties } from 'react';
import type { GalleryPhoto } from '../../types/content';

interface GalleryImageProps {
  photo: GalleryPhoto;
  /** Atributo `sizes` para as variações responsivas. */
  sizes: string;
  className?: string;
}

/**
 * Fotografia otimizada: <picture> com AVIF/WebP quando disponíveis, dimensões
 * reservadas (sem layout shift), carregamento tardio e estado de falha elegante.
 */
export function GalleryImage({ photo, sizes, className }: GalleryImageProps) {
  const [failed, setFailed] = useState(false);
  const style = {
    '--pos': photo.position ?? '50% 50%',
    '--pos-mobile': photo.positionMobile ?? photo.position ?? '50% 50%',
  } as CSSProperties;

  if (failed) {
    return (
      <div className={`gimg gimg--failed ${className ?? ''}`} role="img" aria-label={photo.alt}>
        <span>Imagem indisponível no momento</span>
      </div>
    );
  }

  return (
    <picture className={`gimg ${className ?? ''}`} style={style}>
      {photo.sources?.map((s) => (
        <source key={s.type} type={s.type} srcSet={s.srcSet} sizes={sizes} />
      ))}
      <img
        src={photo.src}
        alt={photo.alt}
        width={photo.width}
        height={photo.height}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
      {photo.placeholder && (
        <span className="gimg__tag" aria-hidden="true">
          Espaço reservado
        </span>
      )}
    </picture>
  );
}
