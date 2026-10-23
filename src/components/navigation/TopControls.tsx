import { Sparkles, WandSparkles } from 'lucide-react';
import { useEffects } from '../effects/EffectsContext';
import { audioConfig } from '../../content/settings';
import { AudioToggle } from './AudioToggle';
import { ChapterMenu } from './ChapterMenu';
import './navigation.css';

interface TopControlsProps {
  /** O menu de capítulos só aparece depois que a carta foi aberta. */
  menuEnabled: boolean;
}

/** Controles flutuantes discretos: capítulos, música (se houver) e animações. */
export function TopControls({ menuEnabled }: TopControlsProps) {
  const { reducedMotion, setMotionPreference } = useEffects();

  return (
    <div className="top-controls">
      <button
        type="button"
        className="icon-btn"
        aria-pressed={reducedMotion}
        aria-label="Reduzir animações"
        title={reducedMotion ? 'Animações reduzidas — toque para ativar todas' : 'Reduzir animações'}
        onClick={() => setMotionPreference(reducedMotion ? 'full' : 'reduced')}
      >
        {reducedMotion ? <Sparkles aria-hidden="true" size={19} strokeWidth={1.5} /> : <WandSparkles aria-hidden="true" size={19} strokeWidth={1.5} />}
      </button>
      {audioConfig.src && <AudioToggle src={audioConfig.src} title={audioConfig.title} volume={audioConfig.volume} autoplay={audioConfig.autoplay} />}
      {menuEnabled && <ChapterMenu />}
    </div>
  );
}
