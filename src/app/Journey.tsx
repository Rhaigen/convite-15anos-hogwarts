import { useEffect, useLayoutEffect } from 'react';
import { ScrollTrigger } from '../animations/gsap';
import { createAmbientDirector } from '../animations/ambient';
import { useEffects } from '../components/effects/EffectsContext';
import { scrollToId } from '../lib/scroll';
import { ClosingScene } from '../sections/ClosingScene/ClosingScene';
import { Countdown } from '../sections/Countdown/Countdown';
import { EventDetails } from '../sections/EventDetails/EventDetails';
import { GiftRegistry } from '../sections/GiftRegistry/GiftRegistry';
import { GreatHall } from '../sections/GreatHall/GreatHall';
import { GryffindorWorld } from '../sections/GryffindorWorld/GryffindorWorld';
import { GuestMessage } from '../sections/GuestMessage/GuestMessage';
import { Passage } from '../sections/Passage/Passage';
import { RsvpSection } from '../sections/RSVP/RsvpSection';
import { SofiaGallery } from '../sections/SofiaGallery/SofiaGallery';

interface JourneyProps {
  opened: boolean;
  deepLink: string | null;
}

/** Capítulos narrativos após a carta (carregados sob demanda). */
export default function Journey({ opened, deepLink }: JourneyProps) {
  const { reducedMotion } = useEffects();

  // Iluminação global por cena. Criada após os capítulos (efeitos dos filhos rodam antes).
  useLayoutEffect(() => {
    const dispose = createAmbientDirector(reducedMotion);
    ScrollTrigger.refresh();
    return dispose;
  }, [reducedMotion]);

  // Recalcula posições quando fontes e imagens terminam de carregar.
  useEffect(() => {
    let timer = 0;
    const refresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => ScrollTrigger.refresh(), 150);
    };
    document.fonts?.ready.then(refresh).catch(() => {});
    const onLoad = (e: Event) => {
      if (e.target instanceof HTMLImageElement) refresh();
    };
    document.addEventListener('load', onLoad, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('load', onLoad, true);
    };
  }, []);

  // Ao abrir a carta, a página volta a rolar: recalcula pins e gatilhos.
  useEffect(() => {
    if (opened) ScrollTrigger.refresh();
  }, [opened]);

  // Link direto para um capítulo (ex.: /#presenca).
  useEffect(() => {
    if (!deepLink) return;
    const id = window.setTimeout(() => {
      ScrollTrigger.refresh();
      scrollToId(deepLink, true);
    }, 120);
    return () => window.clearTimeout(id);
  }, [deepLink]);

  return (
    <>
      <Passage />
      <GryffindorWorld />
      <SofiaGallery />
      <GuestMessage />
      <EventDetails />
      <Countdown />
      <RsvpSection />
      <GiftRegistry />
      <GreatHall />
      <ClosingScene />
    </>
  );
}
