import { useId } from 'react';

/** Contorno irregular de cera derretida, determinístico (sempre igual). */
function waxOutline(): string {
  const points: [number, number][] = [];
  const count = 22;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const wobble = Math.sin(i * 2.7) * 2.6 + Math.cos(i * 1.3) * 2.2 + (i % 5 === 0 ? 3.2 : 0);
    const r = 50 + wobble;
    points.push([Math.cos(angle) * r, Math.sin(angle) * r]);
  }
  const mid = (a: [number, number], b: [number, number]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as const;
  const first = mid(points[count - 1]!, points[0]!);
  let d = `M${first[0].toFixed(2)},${first[1].toFixed(2)}`;
  for (let i = 0; i < count; i++) {
    const p = points[i]!;
    const m = mid(p, points[(i + 1) % count]!);
    d += ` Q${p[0].toFixed(2)},${p[1].toFixed(2)} ${m[0].toFixed(2)},${m[1].toFixed(2)}`;
  }
  return `${d} Z`;
}

const OUTLINE = waxOutline();

interface WaxSealProps {
  className?: string;
  monogram?: string;
}

/** Selo de cera vermelho com monograma em relevo e coroa de 15 pontos. */
export function WaxSeal({ className, monogram = 'S' }: WaxSealProps) {
  const id = useId().replace(/:/g, '');
  const dots = Array.from({ length: 15 }, (_, i) => {
    const a = (i / 15) * Math.PI * 2 - Math.PI / 2;
    return [Math.cos(a) * 30.5, Math.sin(a) * 30.5] as const;
  });

  return (
    <svg className={className} viewBox="-60 -60 120 120" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id={`${id}-wax`} cx="38%" cy="32%" r="75%">
          <stop offset="0%" stopColor="#c42a42" />
          <stop offset="45%" stopColor="#8e1428" />
          <stop offset="100%" stopColor="#4d0712" />
        </radialGradient>
        <radialGradient id={`${id}-press`} cx="55%" cy="60%" r="70%">
          <stop offset="0%" stopColor="#7a1022" />
          <stop offset="100%" stopColor="#9c1a2f" />
        </radialGradient>
      </defs>
      <path d={OUTLINE} fill={`url(#${id}-wax)`} />
      <path d={OUTLINE} fill="none" stroke="rgba(30,0,6,.45)" strokeWidth="1.2" />
      <circle r="38" fill={`url(#${id}-press)`} />
      <circle r="38" fill="none" stroke="rgba(25,0,5,.55)" strokeWidth="2.4" />
      <path d="M -33 -19 A 38 38 0 0 1 19 -33" fill="none" stroke="rgba(255,170,170,.35)" strokeWidth="1.6" strokeLinecap="round" />
      {dots.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="1.5" fill="#5e0b19" stroke="rgba(255,150,150,.25)" strokeWidth=".5" />
      ))}
      <g fontFamily="'Cinzel Variable', Cinzel, Georgia, serif" fontWeight="700" fontSize="40" textAnchor="middle">
        <text x="1.1" y="15.2" fill="rgba(25,0,5,.6)">
          {monogram}
        </text>
        <text x="-0.8" y="13.2" fill="rgba(255,175,175,.42)">
          {monogram}
        </text>
        <text x="0" y="14" fill="#6e0e20">
          {monogram}
        </text>
      </g>
      <ellipse cx="-20" cy="-26" rx="13" ry="6" transform="rotate(-30 -20 -26)" fill="rgba(255,255,255,.16)" />
    </svg>
  );
}
