import { useEffect, useRef } from 'react';
import { Play } from 'lucide-react';
import { gsap } from '../animations/gsap';
import { useEffects } from '../components/effects/EffectsContext';
import { useGsapScene } from '../hooks/useGsapScene';
import { profetaTexts } from '../content/profeta';
import type { ProfetaItem } from '../lib/profeta';

const t = profetaTexts.edition;

export function credit(item: ProfetaItem): string {
  return `${t.number} ${item.n} · ${item.tipo === 'video' ? t.videoBy : t.photoBy} ${item.autor ?? t.anonymous}`;
}

interface EditionProps {
  items: ProfetaItem[];
  /** Números que chegaram nesta atualização (entram com animação). */
  fresh: Set<number>;
  onOpen: (index: number) => void;
}

/**
 * As colunas do jornal. As "fotografias que se movem": as paradas respiram devagar (CSS) e os
 * vídeos tocam mudos em loop, tudo só enquanto o quadro está na tela; sem movimento reduzido.
 */
export function Edition({ items, fresh, onOpen }: EditionProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { reducedMotion } = useEffects();
  const freshKey = [...fresh].join(',');

  useGsapScene(
    ref,
    ({ root, reducedMotion: reduced }) => {
      if (reduced || !freshKey) return;
      const nodes = root.querySelectorAll<HTMLElement>('[data-fresh="true"]');
      gsap.from(nodes, { autoAlpha: 0, y: 28, rotate: -2, scale: 0.94, duration: 0.9, stagger: 0.08, ease: 'power3.out', clearProps: 'transform' });
    },
    [freshKey],
  );

  // Liga a animação/vídeo só do que está na tela (e pausa tudo com a aba escondida).
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const visible = new Set<HTMLElement>();
    const apply = (fig: HTMLElement) => {
      const on = visible.has(fig) && document.visibilityState === 'visible';
      fig.classList.toggle('is-idle', !on);
      const video = fig.querySelector('video');
      if (!video) return;
      if (on && !reducedMotion) void video.play().catch(() => {});
      else video.pause();
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const fig = e.target as HTMLElement;
          if (e.isIntersecting) visible.add(fig);
          else visible.delete(fig);
          apply(fig);
        }
      },
      { rootMargin: '120px 0px' },
    );
    root.querySelectorAll<HTMLElement>('.profeta-photo').forEach((fig) => {
      fig.classList.add('is-idle');
      io.observe(fig);
    });
    const onVisibility = () => root.querySelectorAll<HTMLElement>('.profeta-photo').forEach(apply);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [items, reducedMotion]);

  if (items.length === 0) return <p className="profeta-empty">{t.empty}</p>;

  return (
    <div ref={ref} className="profeta-columns">
      {items.map((item, index) => (
        <figure
          key={item.n}
          className={`profeta-photo profeta-photo--${item.tipo}`}
          data-fresh={fresh.has(item.n) ? 'true' : undefined}
          style={{ animationDelay: `${-(item.n % 7) * 1.3}s` }}
        >
          <button type="button" className="profeta-photo__frame" onClick={() => onOpen(index)} aria-label={`${credit(item)}${item.legenda ? `: ${item.legenda}` : ''}`}>
            {item.tipo === 'video' && item.video ? (
              <>
                <video src={item.video} poster={item.mini} muted loop playsInline preload="none" width={item.w ?? undefined} height={item.h ?? undefined} aria-hidden="true" tabIndex={-1} />
                <span className="profeta-photo__play" aria-hidden="true">
                  <Play size={18} strokeWidth={1.6} />
                </span>
              </>
            ) : (
              <img src={item.mini} alt="" loading="lazy" decoding="async" width={item.w ?? undefined} height={item.h ?? undefined} />
            )}
          </button>
          <figcaption>
            <span className="profeta-photo__credit">{credit(item)}</span>
            {item.legenda && <span className="profeta-photo__caption">{item.legenda}</span>}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}
