interface OrnamentProps {
  className?: string;
}

/** Divisor dourado com losango central e volutas. */
export function Divider({ className }: OrnamentProps) {
  return (
    <svg className={className} viewBox="0 0 260 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M4 12 H96" stroke="currentColor" strokeWidth="1" opacity=".7" />
      <path d="M164 12 H256" stroke="currentColor" strokeWidth="1" opacity=".7" />
      <path d="M96 12 C 104 4, 112 4, 116 12 C 112 20, 104 20, 96 12 Z" stroke="currentColor" strokeWidth="1" />
      <path d="M164 12 C 156 4, 148 4, 144 12 C 148 20, 156 20, 164 12 Z" stroke="currentColor" strokeWidth="1" />
      <path d="M130 2 L140 12 L130 22 L120 12 Z" fill="currentColor" />
      <circle cx="4" cy="12" r="1.6" fill="currentColor" />
      <circle cx="256" cy="12" r="1.6" fill="currentColor" />
    </svg>
  );
}

/** Voluta de canto para molduras de pergaminho. */
export function CornerFlourish({ className }: OrnamentProps) {
  return (
    <svg className={className} viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false">
      <path d="M2 62 V18 C2 9 9 2 18 2 H62" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 62 V22 C8 14 14 8 22 8 H62" stroke="currentColor" strokeWidth=".8" opacity=".7" />
      <path d="M14 30 C 14 20, 20 14, 30 14 C 26 18, 24 24, 26 30 C 22 27, 18 27, 14 30 Z" fill="currentColor" opacity=".85" />
      <circle cx="30" cy="30" r="2.2" fill="currentColor" />
    </svg>
  );
}

/** Estrela de quatro pontas (brilho). */
export function Sparkle({ className }: OrnamentProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 0 C 13 8, 16 11, 24 12 C 16 13, 13 16, 12 24 C 11 16, 8 13, 0 12 C 8 11, 11 8, 12 0 Z" fill="currentColor" />
    </svg>
  );
}

/** Pena de escrever, usada na mensagem aos convidados. */
export function Quill({ className }: OrnamentProps) {
  return (
    <svg className={className} viewBox="0 0 80 200" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="quill-vane" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f8f0e2" />
          <stop offset=".6" stopColor="#d9c7a6" />
          <stop offset="1" stopColor="#a8916c" />
        </linearGradient>
      </defs>
      <path
        d="M62 4 C 30 30, 14 70, 16 118 C 17 140, 22 158, 30 172 C 34 150, 44 120, 52 92 C 60 64, 70 34, 62 4 Z"
        fill="url(#quill-vane)"
        stroke="rgba(41,26,23,.35)"
        strokeWidth="1"
      />
      <path d="M62 6 C 52 60, 40 120, 30 196" stroke="#5a4636" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      <path d="M40 40 L48 46 M34 62 L45 66 M29 86 L41 88 M26 110 L38 110 M25 132 L34 130" stroke="rgba(90,70,54,.45)" strokeWidth=".8" />
      <path d="M30 186 L27 200 L33 189 Z" fill="#291a17" />
    </svg>
  );
}
