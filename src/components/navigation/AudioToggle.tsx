import { useEffect, useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { getMusicState, MUSIC_TOGGLE_ATTR, pauseMusic, playMusic, startMusicOnOpen, subscribeMusic } from '../../lib/music';

interface AudioToggleProps {
  src: string;
  title: string | null;
  volume: number;
  autoplay: boolean;
}

/**
 * Botão da música ambiente. Com `autoplay`, a música começa ao abrir o site (ou
 * no primeiro toque, se o navegador exigir); o botão pausa e retoma.
 */
export function AudioToggle({ src, title, volume, autoplay }: AudioToggleProps) {
  const [state, setState] = useState(getMusicState);

  useEffect(() => subscribeMusic(setState), []);

  useEffect(() => {
    if (!autoplay) return;
    return startMusicOnOpen(src, volume);
  }, [autoplay, src, volume]);

  const playing = state === 'playing';
  const failed = state === 'failed';

  const toggle = () => {
    if (playing) pauseMusic();
    else void playMusic(src, volume);
  };

  const label = failed ? 'Não foi possível tocar a música' : playing ? 'Pausar música ambiente' : 'Tocar música ambiente';

  return (
    <button
      type="button"
      className="icon-btn"
      aria-pressed={playing}
      aria-label={label}
      title={title ? `${label} — ${title}` : label}
      onClick={toggle}
      {...{ [MUSIC_TOGGLE_ATTR]: '' }}
    >
      {playing ? <Volume2 aria-hidden="true" size={19} strokeWidth={1.5} /> : <VolumeX aria-hidden="true" size={19} strokeWidth={1.5} />}
    </button>
  );
}
