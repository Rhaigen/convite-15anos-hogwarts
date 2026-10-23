import './effects.css';

/**
 * Céu atmosférico fixo atrás de todo o conteúdo. A iluminação (cores e
 * posição do brilho) é ajustada por cena via `animations/ambient.ts`,
 * criando continuidade entre os capítulos em vez de blocos separados.
 */
export function AmbientBackdrop() {
  return (
    <div id="ambient" className="ambient" aria-hidden="true">
      <div className="ambient__fog ambient__fog--a" />
      <div className="ambient__fog ambient__fog--b" />
      <div className="ambient__vignette" />
    </div>
  );
}
