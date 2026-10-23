import { lazy, Suspense, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { AmbientBackdrop } from '../components/effects/AmbientBackdrop';
import { ParticleField } from '../components/effects/ParticleField';
import { ScrollProgress } from '../components/navigation/ScrollProgress';
import { TopControls } from '../components/navigation/TopControls';
import { chapters } from '../content/site';
import { readReturnState } from '../lib/giftCheckout';
import { InvitationLetter } from '../sections/InvitationLetter/InvitationLetter';
import { OpeningScene, type RevealMode } from '../sections/OpeningScene/OpeningScene';

// Os capítulos após a carta formam um bloco separado (code splitting), baixado
// enquanto o visitante ainda está diante do envelope.
const Journey = lazy(() => import('./Journey'));

function readDeepLink(): string | null {
  // Volta da página de pagamento do Asaas (?presente=…): direto para a lista de presentes.
  if (readReturnState()) return 'presentes';
  const id = window.location.hash.slice(1);
  return chapters.some((c) => c.id === id) ? id : null;
}

export function App() {
  const [deepLink] = useState(readDeepLink);
  const [opened, setOpened] = useState(deepLink !== null);
  const [reveal, setReveal] = useState<RevealMode | 'pending'>(deepLink ? 'static' : 'pending');
  const letterRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    if (!deepLink) window.scrollTo(0, 0);
  }, [deepLink]);

  // Enquanto o envelope estiver fechado, a página não rola.
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('is-locked', !opened);
  }, [opened]);

  const handleComplete = useCallback(() => {
    setOpened(true);
    requestAnimationFrame(() => document.getElementById('letter-title')?.focus({ preventScroll: true }));
  }, []);

  return (
    <>
      {opened && (
        <a className="skip-link btn btn-gold" href="#presenca">
          Pular para a confirmação de presença
        </a>
      )}
      <AmbientBackdrop />
      <ParticleField />
      <ScrollProgress active={opened} />
      <TopControls menuEnabled={opened} />

      {!opened && <OpeningScene letterTarget={letterRef} onReveal={setReveal} onComplete={handleComplete} />}

      <main id="conteudo" inert={!opened}>
        <InvitationLetter paperRef={letterRef} reveal={reveal} />
        <Suspense fallback={null}>
          <Journey opened={opened} deepLink={deepLink} />
        </Suspense>
      </main>
    </>
  );
}
