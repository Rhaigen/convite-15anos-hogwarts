import { useId } from 'react';
import { GryffindorCrest } from '../../components/ui/GryffindorCrest';

/** Estandarte de tecido carmesim com franja dourada e brasão. */
export function Banner({ className }: { className?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <div className={`banner ${className ?? ''}`} aria-hidden="true">
      <svg className="banner__cloth" viewBox="0 0 180 600" preserveAspectRatio="none" focusable="false">
        <defs>
          <linearGradient id={`${id}-folds`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#4a0812" />
            <stop offset=".12" stopColor="#8e1428" />
            <stop offset=".24" stopColor="#5e0a18" />
            <stop offset=".4" stopColor="#a11c31" />
            <stop offset=".55" stopColor="#6a0c1b" />
            <stop offset=".72" stopColor="#931729" />
            <stop offset=".86" stopColor="#5a0916" />
            <stop offset="1" stopColor="#3d0610" />
          </linearGradient>
          <linearGradient id={`${id}-shade`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="rgba(0,0,0,.35)" />
            <stop offset=".18" stopColor="rgba(0,0,0,0)" />
            <stop offset=".8" stopColor="rgba(0,0,0,0)" />
            <stop offset="1" stopColor="rgba(0,0,0,.4)" />
          </linearGradient>
          <linearGradient id={`${id}-gold`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#fff2c4" />
            <stop offset=".45" stopColor="#c08c38" />
            <stop offset=".7" stopColor="#efcd78" />
            <stop offset="1" stopColor="#99702c" />
          </linearGradient>
        </defs>
        <path d="M14 14 H166 V540 L90 500 L14 540 Z" fill={`url(#${id}-folds)`} />
        <path d="M14 14 H166 V540 L90 500 L14 540 Z" fill={`url(#${id}-shade)`} />
        <path d="M24 24 H156 V522 L90 488 L24 522 Z" fill="none" stroke={`url(#${id}-gold)`} strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
        <path d="M30 30 H150 V512 L90 481 L30 512 Z" fill="none" stroke="rgba(246,217,138,.45)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <path d="M14 540 L14 560 M22 536 L22 552 M158 536 L158 552 M166 540 L166 560 M90 500 L90 518" stroke={`url(#${id}-gold)`} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <rect x="0" y="4" width="180" height="12" rx="6" fill={`url(#${id}-gold)`} />
        <circle cx="6" cy="10" r="8" fill={`url(#${id}-gold)`} />
        <circle cx="174" cy="10" r="8" fill={`url(#${id}-gold)`} />
      </svg>
      <GryffindorCrest className="banner__crest" sizes="6rem" />
    </div>
  );
}
