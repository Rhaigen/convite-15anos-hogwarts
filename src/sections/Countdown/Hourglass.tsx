import { useId } from 'react';

const GLASS =
  'M40 24 C40 82, 76 106, 76 130 C76 154, 40 178, 40 236 H120 C120 178, 84 154, 84 130 C84 106, 120 82, 120 24 Z';

/** Ampulheta com rubis — referência aos pontos das casas, em desenho autoral. */
export function Hourglass({ className }: { className?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className={className} viewBox="0 0 160 260" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-gold`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff2c4" />
          <stop offset=".4" stopColor="#c08c38" />
          <stop offset=".7" stopColor="#efcd78" />
          <stop offset="1" stopColor="#8a6326" />
        </linearGradient>
        <pattern id={`${id}-rubies`} width="10" height="9" patternUnits="userSpaceOnUse">
          <rect width="10" height="9" fill="#5e0716" />
          <path d="M5 0.5 L9.5 4.5 L5 8.5 L0.5 4.5 Z" fill="#b01e36" />
          <path d="M5 0.5 L9.5 4.5 L5 4.5 Z" fill="#e0475d" />
          <path d="M0.5 4.5 L5 4.5 L5 8.5 Z" fill="#7e0d21" />
        </pattern>
        <clipPath id={`${id}-glass`}>
          <path d={GLASS} />
        </clipPath>
        <linearGradient id={`${id}-shine`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="rgba(255,255,255,0)" />
          <stop offset=".25" stopColor="rgba(255,255,255,.22)" />
          <stop offset=".4" stopColor="rgba(255,255,255,0)" />
        </linearGradient>
      </defs>

      <g clipPath={`url(#${id}-glass)`}>
        <path d="M40 24 H120 V64 C 104 70, 56 70, 40 64 Z" fill="transparent" />
        <path d="M43 66 C 60 72, 100 72, 117 66 C 112 92, 86 110, 80 126 C 74 110, 48 92, 43 66 Z" fill={`url(#${id}-rubies)`} />
        <path d="M44 236 C 50 210, 70 198, 80 196 C 90 198, 110 210, 116 236 Z" fill={`url(#${id}-rubies)`} />
        <g className="hourglass__stream">
          {Array.from({ length: 6 }, (_, i) => (
            <circle key={i} className="hourglass__grain" cx="80" cy="128" r="1.6" fill="#e0475d" style={{ animationDelay: `${i * -0.25}s` }} />
          ))}
        </g>
      </g>
      <path d={GLASS} fill="rgba(255,240,220,.06)" stroke="rgba(246,217,138,.65)" strokeWidth="1.5" />
      <path d={GLASS} fill={`url(#${id}-shine)`} />

      <rect x="8" y="6" width="144" height="18" rx="4" fill={`url(#${id}-gold)`} />
      <rect x="8" y="236" width="144" height="18" rx="4" fill={`url(#${id}-gold)`} />
      <rect x="20" y="24" width="6" height="212" rx="3" fill={`url(#${id}-gold)`} />
      <rect x="134" y="24" width="6" height="212" rx="3" fill={`url(#${id}-gold)`} />
      <circle cx="23" cy="130" r="6" fill={`url(#${id}-gold)`} />
      <circle cx="137" cy="130" r="6" fill={`url(#${id}-gold)`} />
      <text x="80" y="250" textAnchor="middle" fontFamily="'Cinzel Variable', Cinzel, Georgia, serif" fontSize="9" fontWeight="700" letterSpacing="2" fill="#4a2d0a">
        XV
      </text>
    </svg>
  );
}
