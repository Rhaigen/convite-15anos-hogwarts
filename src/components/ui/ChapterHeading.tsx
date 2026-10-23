import type { ReactNode } from 'react';
import { Divider } from './Ornaments';
import './chapter-heading.css';

interface ChapterHeadingProps {
  id: string;
  kicker: string;
  title: string;
  intro?: ReactNode;
  /** `light` sobre fundos escuros; `ink` sobre pergaminho. */
  tone?: 'light' | 'ink';
}

/** Título de capítulo com numeração, filete e introdução opcional. */
export function ChapterHeading({ id, kicker, title, intro, tone = 'light' }: ChapterHeadingProps) {
  return (
    <header className={`chapter-heading chapter-heading--${tone}`} data-reveal-heading>
      <p className="chapter-heading__kicker kicker">
        <span className="chapter-heading__line" aria-hidden="true" />
        <span>{kicker}</span>
        <span className="chapter-heading__line" aria-hidden="true" />
      </p>
      <h2 id={id} className="chapter-title chapter-heading__title" tabIndex={-1} data-focus-target>
        {title}
      </h2>
      <Divider className="chapter-heading__divider" />
      {intro && <p className="chapter-heading__intro">{intro}</p>}
    </header>
  );
}
