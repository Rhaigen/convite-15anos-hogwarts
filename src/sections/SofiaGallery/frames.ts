// Gerado por `npm run frames` (scripts/prepare-frames.mjs). Não editar à mão.
import vertical420 from '../../assets/molduras/moldura-vertical-420.webp';
import vertical811 from '../../assets/molduras/moldura-vertical-811.webp';
import horizontal640 from '../../assets/molduras/moldura-horizontal-640.webp';
import horizontal1242 from '../../assets/molduras/moldura-horizontal-1242.webp';

export interface FrameArt {
  /** `srcset` da moldura (WebP com transparência). */
  srcSet: string;
  src: string;
  /** Largura ÷ altura da moldura inteira. */
  ratio: number;
  /** Abertura onde entra a foto, em % de cada lado. */
  window: { top: number; right: number; bottom: number; left: number };
}

export const frameArt: Record<'v' | 'h', FrameArt> = {
  v: {
    srcSet: `${vertical420} 420w, ${vertical811} 811w`,
    src: vertical811,
    ratio: 0.6821,
    window: { top: 12.91, right: 17.82, bottom: 12.91, left: 17.94 },
  },
  h: {
    srcSet: `${horizontal640} 640w, ${horizontal1242} 1242w`,
    src: horizontal1242,
    ratio: 1.5296,
    window: { top: 17.92, right: 12.24, bottom: 17.92, left: 12.32 },
  },
};
