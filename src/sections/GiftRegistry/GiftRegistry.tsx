import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ScrollText } from 'lucide-react';
import { GIFTS_LIGHT } from '../../animations/ambient';
import { gsap } from '../../animations/gsap';
import { revealHeading } from '../../animations/reveal';
import { ChapterHeading } from '../../components/ui/ChapterHeading';
import { WaxSeal } from '../../components/ui/WaxSeal';
import { gifts as copy } from '../../content/texts';
import { useGsapScene } from '../../hooks/useGsapScene';
import { clearReturnState, readReturnState } from '../../lib/giftCheckout';
import './gifts.css';

// O pergaminho (lista, formulário e Cofre Pix) só é baixado quando alguém o abre.
const GiftScroll = lazy(() => import('./GiftScroll'));

/**
 * Capítulo VIII: na página fica só o convite (um pergaminho enrolado com selo); a lista
 * abre num <dialog> em forma de pergaminho. Na volta do Asaas (?presente=…), abre sozinho.
 */
export function GiftRegistry() {
  const ref = useRef<HTMLElement>(null);
  const [returnState] = useState(readReturnState);
  const [open, setOpen] = useState(returnState !== null);
  const [mounted, setMounted] = useState(returnState !== null);

  useEffect(() => {
    if (returnState) clearReturnState();
  }, [returnState]);

  useGsapScene(ref, ({ reducedMotion, root }) => {
    if (reducedMotion) return;
    revealHeading(root);
    const trigger = { trigger: '.gifts__invite', start: 'top 85%', once: true };
    gsap.from('.gifts__rolled', { opacity: 0, y: 40, rotation: -6, duration: 1.1, ease: 'power3.out', scrollTrigger: trigger });
    gsap.from('.gifts__seal', { scale: 0, rotation: -40, duration: 0.8, delay: 0.5, ease: 'back.out(1.8)', scrollTrigger: trigger });
    gsap.from('.gifts__invite-text, .gifts__open', { opacity: 0, y: 18, stagger: 0.12, duration: 0.8, delay: 0.3, ease: 'power2.out', scrollTrigger: trigger });
  });

  const openScroll = () => {
    setMounted(true);
    setOpen(true);
  };

  return (
    <section ref={ref} id="presentes" className={`gifts section-shell${GIFTS_LIGHT === 'gold' ? ' gifts--gold' : ''}`} data-scene="gifts" aria-labelledby="gifts-title">
      <ChapterHeading id="gifts-title" kicker={copy.kicker} title={copy.title} intro={copy.intro} />

      <div className="gifts__invite">
        <div className="gifts__rolled" aria-hidden="true">
          <span className="gifts__rod" />
          <span className="gifts__paper" />
          <span className="gifts__rod" />
          <span className="gifts__ribbon" />
          <WaxSeal className="gifts__seal" />
        </div>
        <p className="gifts__invite-text">{copy.inviteText}</p>
        <button type="button" className="btn btn-gold gifts__open" aria-haspopup="dialog" onClick={openScroll}>
          <ScrollText aria-hidden="true" size={18} />
          {copy.openButton}
        </button>
      </div>

      {mounted && (
        <Suspense fallback={null}>
          <GiftScroll open={open} returnState={returnState} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </section>
  );
}
