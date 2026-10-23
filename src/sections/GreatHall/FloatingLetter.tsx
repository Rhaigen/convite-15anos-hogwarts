import type { CSSProperties } from 'react';
import { WaxSeal } from '../../components/ui/WaxSeal';
import { hall as copy } from '../../content/texts';
import type { WallLetter } from '../../lib/messageWall';
import type { HallSlot } from './hallLayout';

interface FloatingLetterProps {
  letter: WallLetter;
  slot: HallSlot;
  index: number;
  label: string;
  /** Já lida neste navegador: o selo aparece partido. */
  read: boolean;
  onActivate: (index: number, button: HTMLButtonElement) => void;
}

/**
 * Uma carta flutuando sozinha no Salão. Camadas (cada uma com um único dono do `transform`):
 * botão = parallax (GSAP) · __arrive = chegada (GSAP) · __float = flutuação (CSS) · __env = foco/tremor.
 */
export function FloatingLetter({ letter, slot, index, label, read, onActivate }: FloatingLetterProps) {
  const style = {
    '--x': `${(slot.x * 100).toFixed(3)}%`,
    '--y': slot.y.toFixed(4),
    '--rot': `${slot.rotate}deg`,
    '--dur': `${slot.duration.toFixed(2)}s`,
    '--delay': `${(-slot.phase * slot.duration).toFixed(2)}s`,
  } as CSSProperties;

  return (
    <button
      type="button"
      className={`hall-letter hall-letter--d${slot.depth}${read ? ' is-read' : ''}`}
      style={style}
      aria-label={label}
      data-letter-id={letter.id}
      onClick={(e) => onActivate(index, e.currentTarget)}
    >
      <span className="hall-letter__arrive">
        <span className="hall-letter__float">
          <span className="hall-letter__halo" aria-hidden="true" />
          <span className="hall-letter__env" aria-hidden="true">
            <span className="hall-letter__flap" />
            <span className="hall-letter__seal">
              {read ? (
                <>
                  <WaxSeal className="hall-seal-half hall-seal-half--l" />
                  <WaxSeal className="hall-seal-half hall-seal-half--r" />
                </>
              ) : (
                <WaxSeal className="hall-seal" />
              )}
            </span>
            <span className="hall-letter__from">
              <small>{copy.from}</small> {letter.from}
            </span>
          </span>
        </span>
      </span>
    </button>
  );
}
