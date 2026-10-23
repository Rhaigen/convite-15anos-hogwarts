import type { CSSProperties } from 'react';
import { useEffects } from './EffectsContext';
import './candles.css';

export interface CandleSpec {
  x: string;
  y: string;
  /** Escala (profundidade aparente). */
  scale: number;
  /** Intensidade do parallax: 0 (longe) a 1 (perto). */
  depth: number;
}

const DEFAULT_CANDLES: CandleSpec[] = [
  { x: '9%', y: '14%', scale: 0.7, depth: 0.3 },
  { x: '22%', y: '52%', scale: 1, depth: 0.7 },
  { x: '78%', y: '18%', scale: 0.85, depth: 0.5 },
  { x: '88%', y: '58%', scale: 1.15, depth: 0.9 },
  { x: '34%', y: '8%', scale: 0.55, depth: 0.2 },
  { x: '66%', y: '74%', scale: 0.6, depth: 0.25 },
  { x: '14%', y: '82%', scale: 0.75, depth: 0.45 },
];

/** Velas flutuantes (CSS puro), com quantidade reduzida em celulares. */
export function Candles({ candles = DEFAULT_CANDLES }: { candles?: CandleSpec[] }) {
  const { quality } = useEffects();
  const visible = quality === 'high' ? candles : candles.slice(0, 4);
  return (
    <div className="candles" aria-hidden="true">
      {visible.map((c, i) => (
        <div
          key={i}
          className="candle"
          data-depth={c.depth}
          style={{ '--x': c.x, '--y': c.y, '--s': c.scale, '--delay': `${-i * 1.37}s` } as CSSProperties}
        >
          <div className="candle__bob">
            <span className="candle__glow" />
            <span className="candle__flame" />
            <span className="candle__wick" />
            <span className="candle__body" />
          </div>
        </div>
      ))}
    </div>
  );
}
