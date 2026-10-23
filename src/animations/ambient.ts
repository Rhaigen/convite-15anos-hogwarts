import { gsap, ScrollTrigger } from './gsap';
import { particles } from '../lib/particles';

interface ScenePreset {
  top: string;
  bottom: string;
  glow: string;
  glowX: string;
  glowY: string;
  /** Densidade da poeira dourada nesta cena (0–1). */
  dust: number;
}

/**
 * Luz do Capítulo VII (Rede de Flu), aprovada em 2026-10-16: 'floo' = brilho verde das chamas
 * do Pó de Flu atrás do cartão (e halo verde no cartão, visível no celular, onde o cartão cobre o fundo);
 * 'gold' = dourado discreto original. Para voltar, troque para 'gold'.
 */
type RsvpLight = 'floo' | 'gold';
export const RSVP_LIGHT = 'floo' as RsvpLight;
const rsvpLight: Record<RsvpLight, ScenePreset> = {
  floo: { top: '#0b110e', bottom: '#060a08', glow: 'rgba(64,214,132,0.17)', glowX: '50%', glowY: '58%', dust: 0.22 },
  gold: { top: '#120a0e', bottom: '#09060a', glow: 'rgba(216,177,90,0.13)', glowX: '50%', glowY: '30%', dust: 0.22 },
};

/**
 * Luz do Capítulo X (Até Breve), aprovada em 2026-10-16: 'violet' = brilho roxo no fundo
 * (iluminação global + gradiente da própria seção, `.closing--violet`); 'crimson' = carmesim original.
 * Para voltar, troque para 'crimson'.
 */
type ClosingLight = 'violet' | 'crimson';
export const CLOSING_LIGHT = 'violet' as ClosingLight;
const closingLight: Record<ClosingLight, ScenePreset> = {
  violet: { top: '#140a1d', bottom: '#08050d', glow: 'rgba(150,92,232,0.26)', glowX: '50%', glowY: '45%', dust: 1 },
  crimson: { top: '#1d0710', bottom: '#0a0406', glow: 'rgba(246,217,138,0.26)', glowX: '50%', glowY: '45%', dust: 1 },
};

/**
 * Luz do Capítulo VIII (O Cofre dos Presentes), em 2026-10-18: 'gold' = brilho dourado no fundo
 * (iluminação global + halo da própria seção atrás do pergaminho, `.gifts--gold`); 'amber' = âmbar
 * discreto original. Para voltar, troque para 'amber'.
 */
type GiftsLight = 'gold' | 'amber';
export const GIFTS_LIGHT = 'gold' as GiftsLight;
const giftsLight: Record<GiftsLight, ScenePreset> = {
  gold: { top: '#151008', bottom: '#090604', glow: 'rgba(240,196,92,0.26)', glowX: '50%', glowY: '55%', dust: 0.5 },
  amber: { top: '#110a0b', bottom: '#080506', glow: 'rgba(232,160,70,0.15)', glowX: '60%', glowY: '50%', dust: 0.28 },
};

/** Iluminação de cada capítulo — referenciada por `data-scene` nas seções. */
export const scenePresets: Record<string, ScenePreset> = {
  letter: { top: '#1a0d12', bottom: '#0c0709', glow: 'rgba(232,160,70,0.20)', glowX: '50%', glowY: '28%', dust: 0.55 },
  passage: { top: '#0d0710', bottom: '#060409', glow: 'rgba(246,217,138,0.14)', glowX: '50%', glowY: '50%', dust: 0.9 },
  house: { top: '#2a0710', bottom: '#12040a', glow: 'rgba(163,25,47,0.42)', glowX: '50%', glowY: '35%', dust: 0.7 },
  gallery: { top: '#0b0709', bottom: '#060405', glow: 'rgba(180,150,240,0.10)', glowX: '50%', glowY: '45%', dust: 0.2 },
  message: { top: '#160b0c', bottom: '#0b0607', glow: 'rgba(232,160,70,0.20)', glowX: '62%', glowY: '40%', dust: 0.45 },
  details: { top: '#110a10', bottom: '#09060a', glow: 'rgba(216,177,90,0.15)', glowX: '50%', glowY: '45%', dust: 0.4 },
  countdown: { top: '#1d0710', bottom: '#0c0408', glow: 'rgba(163,25,47,0.34)', glowX: '50%', glowY: '40%', dust: 0.6 },
  rsvp: rsvpLight[RSVP_LIGHT],
  gifts: giftsLight[GIFTS_LIGHT],
  // Salão Principal: azul profundo do teto encantado (aprovado em 2026-10-16).
  hall: { top: '#050a24', bottom: '#020510', glow: 'rgba(34,74,196,0.32)', glowX: '50%', glowY: '38%', dust: 0.5 },
  closing: closingLight[CLOSING_LIGHT],
};

function apply(backdrop: HTMLElement, preset: ScenePreset, reducedMotion: boolean) {
  const vars = {
    '--amb-top': preset.top,
    '--amb-bottom': preset.bottom,
    '--amb-glow': preset.glow,
    '--amb-glow-x': preset.glowX,
    '--amb-glow-y': preset.glowY,
  };
  if (reducedMotion) gsap.set(backdrop, vars);
  else gsap.to(backdrop, { ...vars, duration: 1.6, ease: 'power1.inOut', overwrite: 'auto' });
  particles.setAmbient(preset.dust);
}

/**
 * Cria um gatilho por cena que ajusta a iluminação global e a densidade de
 * partículas quando o capítulo ocupa o centro da tela.
 */
export function createAmbientDirector(reducedMotion: boolean): () => void {
  const backdrop = document.getElementById('ambient');
  if (!backdrop) return () => {};
  const triggers = Array.from(document.querySelectorAll<HTMLElement>('[data-scene]')).flatMap((section) => {
    const preset = scenePresets[section.dataset.scene ?? ''];
    if (!preset) return [];
    return [
      ScrollTrigger.create({
        trigger: section,
        start: 'top 55%',
        end: 'bottom 55%',
        onToggle: (self) => {
          if (self.isActive) apply(backdrop, preset, reducedMotion);
        },
      }),
    ];
  });
  return () => triggers.forEach((t) => t.kill());
}
