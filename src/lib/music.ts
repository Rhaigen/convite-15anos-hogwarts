import { gsap } from '../animations/gsap';

/**
 * Música ambiente: um único <audio> para o site inteiro, compartilhado entre o
 * início automático e o botão de som.
 *
 * Navegadores só liberam áudio com som depois de uma interação. Por isso
 * `startMusicOnOpen()` tenta tocar ao carregar e, se for bloqueado, tenta de
 * novo no primeiro clique ou tecla — na prática, o toque no envelope.
 */

export type MusicState = 'idle' | 'playing' | 'paused' | 'failed';

/** Elementos com este atributo controlam a música por conta própria. */
export const MUSIC_TOGGLE_ATTR = 'data-music-toggle';

let audio: HTMLAudioElement | null = null;
let volume = 0.35;
let state: MusicState = 'idle';
/** Pausada por ter saído da aba (volta sozinha), não pelo convidado. */
let pausedByVisibility = false;
const listeners = new Set<(s: MusicState) => void>();

function setState(next: MusicState) {
  state = next;
  listeners.forEach((fn) => fn(next));
}

function fadeTo(target: number, duration: number, onComplete?: () => void) {
  if (!audio) return;
  gsap.killTweensOf(audio);
  gsap.to(audio, { volume: target, duration, ease: 'none', onComplete });
}

function onVisibility() {
  if (!audio) return;
  if (document.hidden && state === 'playing') {
    pausedByVisibility = true;
    gsap.killTweensOf(audio);
    audio.pause();
  } else if (!document.hidden && pausedByVisibility) {
    pausedByVisibility = false;
    audio.play().catch(() => setState('paused'));
  }
}

function ensureAudio(src: string, vol: number) {
  if (audio) return audio;
  volume = vol;
  audio = new Audio();
  audio.src = src;
  audio.loop = true;
  audio.preload = 'none';
  audio.addEventListener('error', () => setState('failed'));
  document.addEventListener('visibilitychange', onVisibility);
  return audio;
}

export function getMusicState() {
  return state;
}

export function subscribeMusic(fn: (s: MusicState) => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Toca com entrada suave de volume. `play()` precisa ser chamado dentro do gesto. */
export async function playMusic(src: string, vol: number): Promise<boolean> {
  const el = ensureAudio(src, vol);
  gsap.killTweensOf(el);
  el.volume = 0;
  try {
    await el.play();
  } catch (error) {
    // Bloqueio do navegador não é falha do arquivo: continua aguardando um gesto.
    if (!(error instanceof DOMException && error.name === 'NotAllowedError')) setState('failed');
    return false;
  }
  setState('playing');
  fadeTo(volume, 1.6);
  return true;
}

export function pauseMusic() {
  const el = audio;
  if (!el || state !== 'playing') return;
  pausedByVisibility = false;
  setState('paused');
  fadeTo(0, 0.8, () => el.pause());
}

/**
 * Início automático. Só age enquanto ninguém mexeu na música: se o convidado
 * pausar ou usar o botão primeiro, a escolha dele prevalece.
 */
export function startMusicOnOpen(src: string, vol: number) {
  let done = false;
  const cleanup = () => {
    done = true;
    window.removeEventListener('click', onGesture, true);
    window.removeEventListener('keydown', onGesture, true);
  };
  const attempt = async () => {
    if (done || state !== 'idle') return cleanup();
    if (await playMusic(src, vol)) cleanup();
  };
  function onGesture(event: Event) {
    const target = event.target;
    if (target instanceof Element && target.closest(`[${MUSIC_TOGGLE_ATTR}]`)) return cleanup();
    void attempt();
  }
  window.addEventListener('click', onGesture, true);
  window.addEventListener('keydown', onGesture, true);
  void attempt();
  return cleanup;
}
