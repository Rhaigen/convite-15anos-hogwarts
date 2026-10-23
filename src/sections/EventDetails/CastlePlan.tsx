import { useId } from 'react';
import { details } from '../../content/texts';

const INK = '#4a2e14';

/**
 * Paredes da planta (com vãos de porta). Desenhadas como linha dupla por uma
 * máscara: traço largo menos traço fino, sem depender da cor do pergaminho.
 */
const WALLS = [
  // Biblioteca e passagem para o corredor de cima
  'M50 80 H10 V16 H84 V80 H60',
  'M50 80 V88 M60 80 V88',
  // Torre da Grifinória (porta embaixo) e passagem
  'M157.2 75.5 A30 30 0 1 0 146.8 75.5',
  'M147 75.5 V88 M157 75.5 V88',
  // Corredor de cima
  'M4 88 H50 M60 88 H147 M157 88 H196',
  'M4 100 H92 M106 100 H196',
  // Corredor central
  'M92 100 V150 M92 160 V232 M92 246 V268 H106 V154 M106 140 V100',
  // Grande Escadaria
  'M80 150 V112 H10 V196 H80 V160',
  'M80 150 H92 M80 160 H92',
  // Saguão de Entrada
  'M80 232 V210 H10 V270 H38 M52 270 H80 V246',
  'M80 232 H92 M80 246 H92',
  // Salão Principal
  'M114 140 V112 H192 V226 H114 V154',
  'M106 140 H114 M106 154 H114',
].join(' ');

/** Estantes da biblioteca, degraus da escadaria e mesas do Salão Principal. */
const FURNITURE = [
  ...[26, 38, 50, 62].flatMap((y) => [`M18 ${y} h26 v3 h-26 Z`, `M50 ${y} h26 v3 h-26 Z`]),
  'M18 120 H40 V180 H18 Z M50 120 H72 V180 H50 Z',
  ...Array.from({ length: 11 }, (_, i) => `M18 ${125 + i * 5} H40 M50 ${125 + i * 5} H72`),
  'M124 120 h60 v4 h-60 Z',
  ...[140, 154, 168, 182].map((x) => `M${x} 134 h3 v74 h-3 Z`),
].join(' ');

/**
 * Trajeto das pegadas: do Saguão de Entrada, pelo corredor, até a porta do
 * Salão Principal. `r` é a direção do passo em graus (0 = para cima).
 */
const ROUTE = [
  { x: 28, y: 257, r: 62 },
  { x: 40, y: 251, r: 66 },
  { x: 52, y: 246, r: 74 },
  { x: 64, y: 242, r: 80 },
  { x: 76, y: 240, r: 86 },
  { x: 88, y: 238, r: 72 },
  { x: 98, y: 229, r: 12 },
  { x: 99, y: 217, r: 0 },
  { x: 99, y: 205, r: 0 },
  { x: 99, y: 193, r: 0 },
  { x: 99, y: 181, r: 0 },
  { x: 100, y: 169, r: 12 },
  { x: 104, y: 158, r: 42 },
  { x: 114, y: 151, r: 74 },
  { x: 126, y: 148, r: 86 },
];

const STEPS = ROUTE.map((p, i) => {
  const side = i % 2 === 0 ? -1 : 1;
  const rad = (p.r * Math.PI) / 180;
  return { x: p.x + Math.cos(rad) * side * 2.6, y: p.y + Math.sin(rad) * side * 2.6, r: p.r, mirror: side };
});

const label = {
  fontFamily: "'Cormorant Garamond', Georgia, serif",
  fontStyle: 'italic',
  fontWeight: 600,
  textAnchor: 'middle' as const,
  fill: INK,
};

/**
 * Planta de cômodos do castelo no estilo do Mapa do Maroto, com pegadas que
 * caminham até o Salão Principal. As pegadas usam a classe `footprint`,
 * animada pela coreografia do capítulo.
 */
export function CastlePlan({ className, name }: { className?: string; name: string }) {
  const id = useId().replace(/:/g, '');
  const rooms = details.mapRooms;

  return (
    <svg className={className} viewBox="0 10 200 266" aria-hidden="true" focusable="false">
      <defs>
        <mask id={`${id}-walls`} maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="300">
          <path d={WALLS} fill="none" stroke="#fff" strokeWidth="2.8" strokeLinecap="square" />
          <path d={WALLS} fill="none" stroke="#000" strokeWidth="1" strokeLinecap="square" />
        </mask>
      </defs>

      <g opacity=".78">
        <rect width="200" height="300" fill={INK} mask={`url(#${id}-walls)`} />
        <g fill="none" stroke={INK} strokeWidth=".6">
          <path d={FURNITURE} />
          <circle cx="152" cy="46" r="24" strokeDasharray="1.5 2.5" />
        </g>

        <g {...label} fontSize="7.5">
          <text x="47" y="75">{rooms.library}</text>
          <text x="152" y="45">{rooms.tower[0]}</text>
          <text x="152" y="54">{rooms.tower[1]}</text>
          <text x="45" y="191">{rooms.stairs}</text>
          <text x="153" y="220">{rooms.hall}</text>
          <text x="45" y="222">{rooms.entrance}</text>
        </g>
        <text {...label} x="130" y="96.6" fontSize="6.2">
          {rooms.hallway}
        </text>
      </g>

      <g>
        {STEPS.map((s, i) => (
          <g key={i} className="footprint" transform={`translate(${s.x.toFixed(1)} ${s.y.toFixed(1)}) rotate(${s.r}) scale(${0.55 * s.mirror} .55)`}>
            <ellipse cx="0" cy="0" rx="4.2" ry="7.5" fill={INK} />
            <ellipse cx="0.4" cy="10.5" rx="3" ry="3.4" fill={INK} />
          </g>
        ))}
      </g>

      {/* Etiqueta com o nome, como as do mapa original */}
      <g>
        <rect x="111" y="157" width="28" height="10" rx="1.5" fill="#efe0bb" stroke={INK} strokeWidth=".6" />
        <text {...label} x="125" y="164.6" fontSize="7.2">
          {name}
        </text>
      </g>
    </svg>
  );
}
