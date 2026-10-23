/**
 * ============================================================================
 *  FOTOGRAFIAS DA GALERIA
 * ============================================================================
 *  Para trocar ou acrescentar fotos:
 *
 *  1. Coloque os arquivos originais (JPG/PNG/WebP) em `fotos-originais/`.
 *  2. Rode `npm run photos` — o script gera versões AVIF/WebP otimizadas em
 *     `public/fotos/` e imprime os itens prontos para colar nesta lista.
 *
 *  A galeria mostra as fotos numa torre espiral, na ordem desta lista (a 1ª
 *  começa na frente). Fotos verticais ganham moldura vertical; horizontais,
 *  moldura horizontal. Funciona com qualquer quantidade a partir de 1 — a
 *  rolagem da torre cresce meia tela por foto.
 *  Trocou uma foto sem mudar o nome? Aumente a versão dela (ver `sources` abaixo).
 *  Escreva textos alternativos que descrevam a cena (acessibilidade).
 *  `position` / `positionMobile` = enquadramento (object-position) em telas largas / verticais.
 * ============================================================================
 */
import type { GalleryPhoto, ImageSource } from '../types/content';

// `version`: ao trocar uma foto mantendo o nome, aumente o número (aqui e no `src`,
// como `?v=2`). Os navegadores guardam as fotos por 7 dias e, sem isso, quem já
// visitou continua vendo a antiga.
const sources = (slug: string, widths: number[], version?: number): ImageSource[] =>
  (['avif', 'webp'] as const).map((ext) => ({
    type: `image/${ext}`,
    srcSet: widths.map((w) => `/fotos/${slug}-${w}.${ext}${version ? `?v=${version}` : ''} ${w}w`).join(', '),
  }));

export const galleryPhotos: GalleryPhoto[] = [
  {
    id: 'fotografia1',
    src: '/fotos/fotografia1.jpg',
    sources: sources('fotografia1', [640, 1280, 1920]),
    width: 1920,
    height: 1280,
    alt: 'Retrato de exemplo 1 (as fotos reais não fazem parte do repositório)',
    position: '50% 35%',
    positionMobile: '52% 40%',
    caption: null,
  },
  {
    id: 'fotografia2',
    src: '/fotos/fotografia2.jpg',
    sources: sources('fotografia2', [640, 842]),
    width: 842,
    height: 1264,
    alt: 'Retrato de exemplo 2 (as fotos reais não fazem parte do repositório)',
    position: '50% 30%',
    caption: null,
  },
  {
    id: 'fotografia3',
    src: '/fotos/fotografia3.jpg',
    sources: sources('fotografia3', [640, 1280, 1920]),
    width: 1920,
    height: 2880,
    alt: 'Retrato de exemplo 3 (as fotos reais não fazem parte do repositório)',
    position: '50% 70%',
    caption: null,
  },
  {
    id: 'fotografia4',
    src: '/fotos/fotografia4.jpg',
    sources: sources('fotografia4', [640, 1280, 1920]),
    width: 1920,
    height: 2879,
    alt: 'Retrato de exemplo 4 (as fotos reais não fazem parte do repositório)',
    position: '50% 28%',
    caption: null,
  },
  {
    id: 'fotografia5',
    src: '/fotos/fotografia5.jpg',
    sources: sources('fotografia5', [640, 1280, 1920]),
    width: 1920,
    height: 2880,
    alt: 'Retrato de exemplo 5 (as fotos reais não fazem parte do repositório)',
    position: '50% 45%',
    caption: null,
  },
  {
    id: 'fotografia6',
    src: '/fotos/fotografia6.jpg',
    sources: sources('fotografia6', [640, 1280, 1920]),
    width: 1920,
    height: 1280,
    alt: 'Retrato de exemplo 6 (as fotos reais não fazem parte do repositório)',
    position: '50% 32%',
    positionMobile: '85% 50%',
    caption: null,
  },
  {
    id: 'fotografia7',
    src: '/fotos/fotografia7.jpg',
    sources: sources('fotografia7', [640, 1280, 1920]),
    width: 1920,
    height: 2880,
    alt: 'Retrato de exemplo 7 (as fotos reais não fazem parte do repositório)',
    position: '50% 40%',
    caption: null,
  },
  {
    id: 'fotografia8',
    src: '/fotos/fotografia8.jpg?v=2',
    sources: sources('fotografia8', [640, 1280, 1920], 2),
    width: 1920,
    height: 2880,
    alt: 'Retrato de exemplo 8 (as fotos reais não fazem parte do repositório)',
    position: '45% 60%',
    caption: null,
  },
  {
    id: 'fotografia9',
    src: '/fotos/fotografia9.jpg',
    sources: sources('fotografia9', [640, 1280, 1920]),
    width: 1920,
    height: 1280,
    alt: 'Retrato de exemplo 9 (as fotos reais não fazem parte do repositório)',
    position: '50% 35%',
    caption: null,
  },
  {
    id: 'fotografia10',
    src: '/fotos/fotografia10.jpg',
    sources: sources('fotografia10', [640, 1280, 1920]),
    width: 1920,
    height: 2882,
    alt: 'Retrato de exemplo 10 (as fotos reais não fazem parte do repositório)',
    position: '50% 45%',
    caption: null,
  },
  {
    id: 'fotografia11',
    src: '/fotos/fotografia11.jpg',
    sources: sources('fotografia11', [640, 1280, 1920]),
    width: 1920,
    height: 2879,
    alt: 'Retrato de exemplo 11 (as fotos reais não fazem parte do repositório)',
    position: '50% 40%',
    caption: null,
  },
  {
    id: 'fotografia12',
    src: '/fotos/fotografia12.jpg',
    sources: sources('fotografia12', [640, 1280, 1920]),
    width: 1920,
    height: 2880,
    alt: 'Retrato de exemplo 12 (as fotos reais não fazem parte do repositório)',
    position: '55% 40%',
    caption: null,
  },
  {
    id: 'fotografia13',
    src: '/fotos/fotografia13.jpg',
    sources: sources('fotografia13', [640, 1280, 1920]),
    width: 2752,
    height: 1536,
    alt: 'Retrato de exemplo 13 (as fotos reais não fazem parte do repositório)',
    position: '50% 40%',
    caption: null,
  },
];
