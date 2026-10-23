/**
 * Lareira com as chamas verdes do Pó de Flu (decorativa). Cada chama tremula por
 * CSS (rsvp.css); o GSAP só anima o <svg> inteiro, nunca as chamas.
 */
const FLAME = 'M0 0 C-17 0 -23 -15 -18 -28 C-14 -38 -6 -42 -8 -58 C4 -50 12 -38 10 -26 C14 -30 16 -36 15 -42 C24 -32 26 -16 18 -7 C14 -2 7 0 0 0 Z';

export function FlooFlames({ className = '' }: { className?: string }) {
  return (
    <svg className={`floo-flames ${className}`} viewBox="0 0 160 110" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="floo-flame-grad" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#eafff2" />
          <stop offset="0.28" stopColor="#7df0b0" />
          <stop offset="0.7" stopColor="#19a866" />
          <stop offset="1" stopColor="#0b6b40" stopOpacity="0.85" />
        </linearGradient>
        <radialGradient id="floo-glow-grad">
          <stop offset="0" stopColor="#5df2a2" stopOpacity="0.75" />
          <stop offset="1" stopColor="#5df2a2" stopOpacity="0" />
        </radialGradient>
      </defs>

      <ellipse className="floo-flames__glow" cx="80" cy="82" rx="64" ry="34" fill="url(#floo-glow-grad)" />

      <g fill="url(#floo-flame-grad)">
        <g transform="translate(52 92) scale(0.78)">
          <path className="floo-flames__flame floo-flames__flame--a" d={FLAME} />
        </g>
        <g transform="translate(108 92) scale(0.72) scale(-1 1)">
          <path className="floo-flames__flame floo-flames__flame--b" d={FLAME} />
        </g>
        <g transform="translate(80 94) scale(1.08)">
          <path className="floo-flames__flame floo-flames__flame--c" d={FLAME} />
        </g>
      </g>

      {/* Toras e grelha */}
      <g className="floo-flames__logs">
        <rect x="38" y="90" width="58" height="10" rx="5" transform="rotate(-7 67 95)" fill="#4a2a14" />
        <rect x="64" y="90" width="58" height="10" rx="5" transform="rotate(7 93 95)" fill="#5c3519" />
        <path d="M30 104 H130" stroke="#9e7a33" strokeWidth="2.5" strokeLinecap="round" />
      </g>
    </svg>
  );
}
