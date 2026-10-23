import grifinoria220 from '../../assets/brasoes/grifinoria-220.webp';
import grifinoria520 from '../../assets/brasoes/grifinoria-520.webp';

interface GryffindorCrestProps {
  className?: string;
  title?: string;
  /** Largura exibida, para o navegador escolher a resolução (atributo `sizes`). */
  sizes?: string;
}

/**
 * Brasão da Grifinória (arte da família, preparada por `npm run crests`
 * a partir de brasoes-originais/grifinoria.jpg).
 */
export function GryffindorCrest({ className, title, sizes = '15rem' }: GryffindorCrestProps) {
  return (
    <img
      className={className}
      src={grifinoria520}
      srcSet={`${grifinoria220} 220w, ${grifinoria520} 520w`}
      sizes={sizes}
      width={520}
      height={696}
      alt={title ?? ''}
      aria-hidden={title ? undefined : true}
      loading="lazy"
      decoding="async"
      draggable={false}
    />
  );
}
