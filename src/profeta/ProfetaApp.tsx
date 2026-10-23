import { useCallback, useEffect, useRef, useState } from 'react';
import { useEffects } from '../components/effects/EffectsContext';
import { event } from '../content/event';
import { profetaConfig, profetaTexts } from '../content/profeta';
import { formatDateLong } from '../lib/date';
import {
  demoEdition,
  fetchEdition,
  fetchSession,
  ProfetaError,
  profetaDemoParam,
  type ProfetaItem,
  type SessionInfo,
  type WindowState,
} from '../lib/profeta';
import { Edition } from './Edition';
import { Gate } from './Gate';
import { Sender } from './Sender';
import { Viewer } from './Viewer';

type Phase = 'carregando' | 'porta' | 'jornal' | 'fora';

/**
 * O Profeta Diário: porta (palavra mágica) → jornal com as fotografias dos convidados, que se
 * atualiza sozinho com a aba visível. Sem a VPS no ar, avisa e tenta de novo; nunca inventa fotos.
 */
export function ProfetaApp() {
  const demo = profetaDemoParam();
  const { reducedMotion } = useEffects();
  const [phase, setPhase] = useState<Phase>('carregando');
  const [janela, setJanela] = useState<WindowState>('aberta');
  const [items, setItems] = useState<ProfetaItem[]>([]);
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const [stale, setStale] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const version = useRef<number | null>(null);
  const known = useRef<Set<number> | null>(null);

  const enter = useCallback((session: SessionInfo) => {
    setJanela(session.janela);
    setPhase(session.entrou ? 'jornal' : 'porta');
  }, []);

  const refresh = useCallback(async () => {
    if (demo) return;
    try {
      const edition = await fetchEdition(version.current);
      setStale(false);
      if (!edition) return;
      version.current = edition.v;
      setJanela(edition.janela);
      const before = known.current;
      known.current = new Set(edition.itens.map((i) => i.n));
      setFresh(before ? new Set(edition.itens.filter((i) => !before.has(i.n)).map((i) => i.n)) : new Set());
      setItems(edition.itens);
    } catch (error) {
      if (error instanceof ProfetaError && error.code === 'sem_sessao') setPhase('porta');
      else setStale(true);
    }
  }, [demo]);

  // Começo: demonstração (só no dev) ou a sessão real.
  useEffect(() => {
    let cancelled = false;
    // import.meta.env.DEV explícito: no build este ramo some e a edição fictícia nem é publicada.
    if (import.meta.env.DEV && demo) {
      void demoEdition(demo).then((ed) => {
        if (cancelled) return;
        setItems(ed.itens);
        setJanela(ed.janela);
        setPhase(demo === 'porta' ? 'porta' : 'jornal');
      });
    } else {
      fetchSession()
        .then((s) => !cancelled && enter(s))
        .catch(() => !cancelled && setPhase('fora'));
    }
    return () => {
      cancelled = true;
    };
  }, [demo, enter]);

  // Jornal aberto: busca agora e a cada `pollSeconds`, só com a aba visível.
  useEffect(() => {
    if (phase !== 'jornal' || demo) return;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, profetaConfig.pollSeconds * 1000);
    const onVisible = () => document.visibilityState === 'visible' && void refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [phase, demo, refresh]);

  // Depois de um envio, a foto leva alguns segundos no ffmpeg: procura de novo em seguida.
  const afterSend = useCallback(() => {
    window.setTimeout(() => void refresh(), 4000);
    window.setTimeout(() => void refresh(), 15000);
  }, [refresh]);

  const retry = () => {
    setPhase('carregando');
    fetchSession().then(enter, () => setPhase('fora'));
  };

  return (
    <main className={`profeta-page${reducedMotion ? ' is-reduced' : ''}`}>
      <article className="profeta-sheet">
        <header className="profeta-masthead">
          <p className="profeta-masthead__rail">
            <span>{profetaTexts.kicker}</span>
            <span className="profeta-masthead__date">{formatDateLong(event.date)}</span>
            <span>{profetaTexts.price}</span>
          </p>
          <h1 className="profeta-masthead__title">{profetaTexts.masthead}</h1>
        </header>

        {phase === 'carregando' && <p className="profeta-loading" aria-live="polite">…</p>}

        {phase === 'fora' && (
          <div className="profeta-gate">
            <p className="profeta-error" role="alert">
              {profetaTexts.edition.unavailable}
            </p>
            <button type="button" className="profeta-btn" onClick={retry}>
              {profetaTexts.gate.submit}
            </button>
          </div>
        )}

        {phase === 'porta' && <Gate onEnter={enter} />}

        {phase === 'jornal' && (
          <>
            <section className="profeta-lead">
              <h2 className="profeta-lead__headline">{profetaTexts.headline}</h2>
              <p className="profeta-lead__standfirst">
                {profetaTexts.standfirst}
                {items.length > 0 && <span className="profeta-lead__count"> {profetaTexts.edition.count(items.length)}.</span>}
              </p>
            </section>
            <Sender janela={janela} onSent={afterSend} onSessionLost={() => setPhase('porta')} />
            {stale && (
              <p className="profeta-error profeta-error--soft" role="status">
                {profetaTexts.edition.unavailable}
              </p>
            )}
            <Edition items={items} fresh={fresh} onOpen={setOpen} />
          </>
        )}
      </article>
      <Viewer items={items} index={open} onNavigate={setOpen} onClose={() => setOpen(null)} />
    </main>
  );
}
