/**
 * Lista de presentes no navegador: carrega a lista, lê o progresso das vaquinhas
 * (site-gifts, só GET) e pede o link de pagamento (gift-checkout). O site não guarda
 * nem calcula nada que valha: o servidor recalcula o preço, e o pagamento é feito na
 * página do Asaas. Na volta, `?presente=enviado|cancelado|expirado` abre o pergaminho.
 */
import { giftList } from '../content/gifts';
import { giftsConfig } from '../content/settings';
import type { Gift } from '../types/content';
import type { PaymentMethod } from './giftPricing';

const TIMEOUT_MS = 12_000;

export type ReturnState = 'enviado' | 'cancelado' | 'expirado';

export interface CheckoutPayload {
  giftId: string;
  /** Botão escolhido: o checkout do Asaas só oferece essa forma. */
  method: PaymentMethod;
  amountCents?: number;
  message?: string | null;
  signature?: string | null;
  anonymous?: boolean;
  /** Campo-isca contra robôs (sempre vazio para pessoas). */
  website?: string;
}

export type CheckoutResult = { ok: true; url: string } | { ok: false; error: 'busy' | 'signature_required' | 'generic' };

export function checkoutEndpoint(): string | null {
  return import.meta.env.VITE_GIFT_CHECKOUT_URL || giftsConfig.checkoutEndpoint;
}

export function progressEndpoint(): string | null {
  return import.meta.env.VITE_GIFT_PROGRESS_URL || giftsConfig.progressEndpoint;
}

/** Lista fictícia: `?presentes=demo` no `npm run dev`, ou o build do e2e. */
export function giftsDemoEnabled(search = typeof location === 'undefined' ? '' : location.search): boolean {
  if (__GIFTS_DEMO__) return true;
  return import.meta.env.DEV && new URLSearchParams(search).get('presentes') === 'demo';
}

/** No dev com a demonstração, o checkout é só simulado (as funções podem nem estar no ar). */
export const simulateCheckout = (demo: boolean) => import.meta.env.DEV && demo;

export interface LoadedGifts {
  gifts: Gift[];
  demo: boolean;
  /** Progresso fictício das vaquinhas (só na demonstração do dev). */
  demoProgress: Record<string, number> | null;
}

export async function loadGifts(): Promise<LoadedGifts> {
  if ((__GIFTS_DEMO__ || import.meta.env.DEV) && giftsDemoEnabled()) {
    const data = (await import('../../scripts/fixtures/presentes-demo.json')).default as { gifts: Gift[]; progress: Record<string, number> };
    return { gifts: data.gifts, demo: true, demoProgress: import.meta.env.DEV ? data.progress : null };
  }
  return { gifts: giftList, demo: false, demoProgress: null };
}

/** Lê `?presente=` da volta do Asaas. */
export function readReturnState(search = typeof location === 'undefined' ? '' : location.search): ReturnState | null {
  const value = new URLSearchParams(search).get('presente');
  return value === 'enviado' || value === 'cancelado' || value === 'expirado' ? value : null;
}

/** Tira `?presente=` do endereço (recarregar não reabre o agradecimento). */
export function clearReturnState(): void {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('presente')) return;
    url.searchParams.delete('presente');
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash || '#presentes'}`);
  } catch {
    /* sem History API: só não limpa */
  }
}

/** Link do checkout: só https em asaas.com (a função já confere; aqui, por garantia). */
export function isCheckoutUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'asaas.com' || url.hostname.endsWith('.asaas.com')) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Progresso das vaquinhas: id → centavos arrecadados. Lança erro se a função falhar. */
export async function fetchProgress(url: string, signal?: AbortSignal): Promise<Map<string, number>> {
  const res = await fetch(url, { method: 'GET', credentials: 'omit', signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { gifts?: unknown };
  const map = new Map<string, number>();
  for (const item of Array.isArray(data.gifts) ? data.gifts : []) {
    const g = (item ?? {}) as { id?: unknown; raisedCents?: unknown };
    if (typeof g.id === 'string' && typeof g.raisedCents === 'number' && Number.isFinite(g.raisedCents) && g.raisedCents >= 0) {
      map.set(g.id, Math.round(g.raisedCents));
    }
  }
  return map;
}

/** Pede o link de pagamento. Nunca lança: devolve um erro que a interface sabe mostrar. */
export async function startCheckout(url: string, payload: CheckoutPayload): Promise<CheckoutResult> {
  const timeout = new AbortController();
  const timer = window.setTimeout(() => timeout.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'omit',
      signal: timeout.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = (await res.json().catch(() => ({}))) as { url?: unknown; error?: unknown };
    if (res.ok && isCheckoutUrl(data.url)) return { ok: true, url: data.url };
    if (res.status === 429) return { ok: false, error: 'busy' };
    if (data.error === 'signature_required') return { ok: false, error: 'signature_required' };
    return { ok: false, error: 'generic' };
  } catch {
    return { ok: false, error: 'generic' };
  } finally {
    window.clearTimeout(timer);
  }
}
