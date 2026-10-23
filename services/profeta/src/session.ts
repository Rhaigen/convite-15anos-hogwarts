/**
 * Porta do Profeta: palavra mágica → cookie de sessão assinado (HMAC, sem estado no servidor).
 * Também o segredo das rotas internas e o limite de tentativas.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const COOKIE_NAME = 'profeta';
export const SESSION_DAYS = 60;

/** "Lúmos  Máxima" = "lumos maxima": o cartão é lido e digitado no celular, na festa. */
export function normalizePassword(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/** Comparação em tempo constante (resumos de mesmo tamanho). */
export function sameSecret(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

export function checkPassword(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || given.length > 200) return false;
  return sameSecret(normalizePassword(given), normalizePassword(expected));
}

const b64url = (buf: Buffer) => buf.toString('base64url');
const sign = (payload: string, secret: string) => b64url(createHmac('sha256', secret).update(payload).digest());

export interface Session {
  /** Identificador aleatório da sessão (limite de envios por pessoa). */
  sid: string;
  exp: number;
}

export function createSession(secret: string, now = Date.now()): { token: string; session: Session } {
  const session: Session = { sid: b64url(randomBytes(12)), exp: now + SESSION_DAYS * 86_400_000 };
  const payload = b64url(Buffer.from(JSON.stringify(session)));
  return { token: `${payload}.${sign(payload, secret)}`, session };
}

export function readSession(token: string | null | undefined, secret: string, now = Date.now()): Session | null {
  if (!token || token.length > 400) return null;
  const [payload, mac, extra] = token.split('.');
  if (!payload || !mac || extra !== undefined) return null;
  if (!sameSecret(mac, sign(payload, secret))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<Session>;
    if (typeof data.sid !== 'string' || typeof data.exp !== 'number' || data.exp <= now) return null;
    return { sid: data.sid, exp: data.exp };
  } catch {
    return null;
  }
}

export function cookieValue(header: string | undefined, name = COOKIE_NAME): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=') || null;
  }
  return null;
}

/** Só o site do convite lê (httpOnly), só por HTTPS, e não acompanha navegação vinda de outro site. */
export function sessionCookie(token: string, maxAgeSeconds = SESSION_DAYS * 86_400): string {
  return `${COOKIE_NAME}=${token}; Path=/api/profeta; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

/** Janela deslizante simples em memória: `max` eventos por `windowMs`, por chave (IP ou sessão). */
export function createRateLimiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return {
    /** Registra uma tentativa; false = passou do limite (não registra). */
    take(key: string, now = Date.now()): boolean {
      const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      if (hits.size > 5000) {
        for (const [k, list] of hits) if (list.every((t) => now - t >= windowMs)) hits.delete(k);
      }
      return true;
    },
  };
}
