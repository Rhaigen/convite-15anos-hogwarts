import hogwarts300 from '../../assets/brasoes/hogwarts-300.webp';

interface HogwartsCrestProps {
  className?: string;
  title?: string;
}

/**
 * Brasão de Hogwarts (arte da família, preparada por `npm run crests`
 * a partir de brasoes-originais/hogwarts.jpg).
 */
export function HogwartsCrest({ className, title }: HogwartsCrestProps) {
  return (
    <img
      className={className}
      src={hogwarts300}
      width={300}
      height={364}
      alt={title ?? ''}
      aria-hidden={title ? undefined : true}
      decoding="async"
      draggable={false}
    />
  );
}
