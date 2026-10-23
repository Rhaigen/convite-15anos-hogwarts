import sofia280 from '../../assets/brasoes/sofia-280.webp';
import sofia512 from '../../assets/brasoes/sofia-512.webp';

interface SofiaCrestProps {
  className?: string;
  title?: string;
  /** Largura exibida, para o navegador escolher a resolução (atributo `sizes`). */
  sizes?: string;
}

/**
 * Brasão pessoal da Sofia, prata e roxo (arte da família, preparada por
 * `npm run crests` a partir de brasoes-originais/sofia.jpg).
 */
export function SofiaCrest({ className, title, sizes = '15rem' }: SofiaCrestProps) {
  return (
    <img
      className={className}
      src={sofia512}
      srcSet={`${sofia280} 280w, ${sofia512} 512w`}
      sizes={sizes}
      width={512}
      height={714}
      alt={title ?? ''}
      aria-hidden={title ? undefined : true}
      loading="lazy"
      decoding="async"
      draggable={false}
    />
  );
}
