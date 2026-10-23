import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { event } from '../src/content/event';
import { buildIcs, getMapUrl, googleCalendarUrl, toCalendarEntry } from '../src/lib/calendar';
import { computeCountdown, describeCountdown, unitLabel } from '../src/lib/countdown';
import { formatDateLong, getDateParts, getEventDayEnd, getEventStart, toRoman } from '../src/lib/date';
import { formatWhatsappNumber, isWhatsappNumber, whatsappUrl } from '../src/lib/whatsapp';
import { giftsConfig, messageWallConfig, rsvpConfig } from '../src/content/settings';
import { rsvp as rsvpCopy } from '../src/content/texts';
import { profetaConfig } from '../src/content/profeta';

describe('datas do evento', () => {
  it('usa a data oficial: sábado, 20 de fevereiro de 2027', () => {
    expect(event.date).toBe('2027-02-20');
    expect(formatDateLong(event.date)).toBe('sábado, 20 de fevereiro de 2027');
    expect(getDateParts(event.date)).toEqual({ weekday: 'sábado', day: '20', month: 'fevereiro', year: '2027' });
  });

  it('sem horário definido, a referência provisória é 00:00 no fuso do evento', () => {
    expect(getEventStart({ date: '2027-02-20', time: null, utcOffset: '-03:00' }).toISOString()).toBe('2027-02-20T03:00:00.000Z');
    expect(getEventStart({ date: '2027-02-20', time: '20:30', utcOffset: '-03:00' }).toISOString()).toBe('2027-02-20T23:30:00.000Z');
  });

  it('rejeita configurações inválidas', () => {
    expect(() => getEventStart({ date: '20/02/2027', time: null, utcOffset: '-03:00' })).toThrow();
    expect(() => getEventStart({ date: '2027-02-20', time: '25:00', utcOffset: '-03:00' })).toThrow();
  });

  it('converte números romanos', () => {
    expect([1, 4, 9, 15, 2027].map(toRoman)).toEqual(['I', 'IV', 'IX', 'XV', 'MMXXVII']);
  });
});

describe('contagem regressiva', () => {
  const target = new Date('2027-02-20T03:00:00Z');
  const dayEnd = getEventDayEnd({ date: '2027-02-20', utcOffset: '-03:00' });

  it('calcula a partir do instante de destino', () => {
    const now = target.getTime() - (2 * 86_400 + 3 * 3_600 + 4 * 60 + 5) * 1000 - 400;
    expect(computeCountdown(target, dayEnd, now)).toEqual({ status: 'upcoming', days: 2, hours: 3, minutes: 4, seconds: 5 });
  });

  it('indica o dia da festa e o pós-evento', () => {
    expect(computeCountdown(target, dayEnd, target.getTime() + 1000).status).toBe('today');
    expect(computeCountdown(target, dayEnd, dayEnd.getTime() + 1).status).toBe('past');
  });

  it('usa singular e plural em português', () => {
    expect(unitLabel('days', 1)).toBe('dia');
    expect(unitLabel('hours', 0)).toBe('horas');
    expect(describeCountdown({ status: 'upcoming', days: 1, hours: 2, minutes: 1, seconds: 0 })).toBe(
      'Faltam 1 dia, 2 horas e 1 minuto para a celebração.',
    );
  });
});

describe('link da Professora Aifos (WhatsApp)', () => {
  it('monta o wa.me com a mensagem inicial codificada', () => {
    const url = whatsappUrl('5511999999999', 'Olá, Professora Aifos! Tudo bem?');
    expect(url).toBe('https://wa.me/5511999999999?text=Ol%C3%A1%2C%20Professora%20Aifos!%20Tudo%20bem%3F');
    expect(new URL(url!).searchParams.get('text')).toBe('Olá, Professora Aifos! Tudo bem?');
    expect(whatsappUrl('5511999999999')).toBe('https://wa.me/5511999999999');
    expect(whatsappUrl('5511999999999', '   ')).toBe('https://wa.me/5511999999999');
  });

  it('recusa número ausente ou fora do formato (só dígitos, com DDI)', () => {
    expect(whatsappUrl(null, 'oi')).toBeNull();
    for (const bad of ['', '+5511999999999', '55 11 99999-9999', '11999999999x', '0551199999999', '12345']) {
      expect(isWhatsappNumber(bad), bad).toBe(false);
    }
    expect(isWhatsappNumber('5511999999999')).toBe(true);
  });

  it('exibe o número no formato brasileiro', () => {
    expect(formatWhatsappNumber('5511999999999')).toBe('+55 11 99999-9999');
    expect(formatWhatsappNumber('552733334444')).toBe('+55 27 3333-4444');
    expect(formatWhatsappNumber('14155550100')).toBe('+14155550100');
  });

  it('a configuração do convite tem um número válido e a mensagem inicial', () => {
    expect(rsvpConfig.whatsappNumber === null || isWhatsappNumber(rsvpConfig.whatsappNumber)).toBe(true);
    expect(rsvpCopy.greeting).toMatch(/Aifos/);
  });
});

describe('front sem banco de dados', () => {
  it('nenhum arquivo de src/ usa o cliente do Supabase nem chaves (a confirmação é feita pela Aifos no WhatsApp)', () => {
    const files = readdirSync('src', { recursive: true, withFileTypes: true })
      .filter((f) => f.isFile() && /\.(ts|tsx)$/.test(f.name))
      .map((f) => join(f.parentPath, f.name));
    expect(files.length).toBeGreaterThan(20);
    const offenders = files.filter((f) => /@supabase\/|VITE_SUPABASE|apikey|service_role|sb_(publishable|secret)_|eyJhbGci/i.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('as únicas referências ao Supabase são as funções públicas: cartas do Salão e lista de presentes', () => {
    const files = readdirSync('src', { recursive: true, withFileTypes: true })
      .filter((f) => f.isFile() && /\.(ts|tsx)$/.test(f.name))
      .map((f) => join(f.parentPath, f.name).replace(/\\/g, '/'));
    const mentions = files.flatMap((f) => (readFileSync(f, 'utf8').match(/https?:\/\/[^'"`\s]*supabase\.co[^'"`\s]*/gi) ?? []).map((url) => `${f} ${url}`));
    expect(
      mentions.every((m) => /^src\/content\/settings\.ts https:\/\/[a-z0-9]+\.supabase\.co\/functions\/v1\/(site-messages|site-gifts|gift-checkout)$/.test(m)),
      mentions.join('\n'),
    ).toBe(true);
    expect(messageWallConfig.endpoint === null || /\/functions\/v1\/site-messages$/.test(messageWallConfig.endpoint)).toBe(true);
    expect(giftsConfig.checkoutEndpoint === null || /\/functions\/v1\/gift-checkout$/.test(giftsConfig.checkoutEndpoint)).toBe(true);
    expect(giftsConfig.progressEndpoint === null || /\/functions\/v1\/site-gifts$/.test(giftsConfig.progressEndpoint)).toBe(true);
  });

  it('só dois lugares escrevem: o pedido do link de pagamento e o Profeta Diário (mesma origem, sem chave)', () => {
    const files = readdirSync('src', { recursive: true, withFileTypes: true })
      .filter((f) => f.isFile() && /\.(ts|tsx)$/.test(f.name))
      .map((f) => join(f.parentPath, f.name).replace(/\\/g, '/'));
    const writes = files.filter((f) => /method:\s*'(POST|PUT|PATCH|DELETE)'|\.open\(\s*'(POST|PUT|PATCH|DELETE)'/.test(readFileSync(f, 'utf8')));
    expect(writes).toEqual(['src/lib/giftCheckout.ts', 'src/lib/profeta.ts']);
    // O Profeta só fala com /api/profeta do próprio domínio (o Traefik leva ao serviço da VPS).
    const profeta = readFileSync('src/lib/profeta.ts', 'utf8');
    expect(profeta).not.toMatch(/https?:\/\//);
    expect(profetaConfig.api).toBe('/api/profeta');
    expect(files.filter((f) => /\$aact_|ASAAS_API_KEY|access_token/.test(readFileSync(f, 'utf8')))).toEqual([]);
  });
});

describe('calendário e mapa', () => {
  it('cria evento de dia inteiro enquanto o horário não é definido', () => {
    const entry = toCalendarEntry({ ...event, time: null });
    const ics = buildIcs(entry, new Date('2026-10-12T12:00:00Z'));
    expect(ics).toContain('DTSTART;VALUE=DATE:20270220');
    expect(ics).toContain('DTEND;VALUE=DATE:20270221');
    expect(ics).toContain('LOCATION:Cerimonial Casa de Pedra Slim');
    expect(ics.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(googleCalendarUrl(entry)).toContain('dates=20270220%2F20270221');
  });

  it('usa horário em UTC quando definido', () => {
    const ics = buildIcs(toCalendarEntry({ ...event, time: '20:00', durationHours: 5 }));
    expect(ics).toContain('DTSTART:20270220T230000Z');
    expect(ics).toContain('DTEND:20270221T040000Z');
  });

  it('só oferece mapa com dado real e seguro', () => {
    expect(getMapUrl({ venue: 'X', address: null, mapUrl: null })).toBeNull();
    expect(getMapUrl({ venue: 'X', address: null, mapUrl: 'javascript:alert(1)' })).toBeNull();
    expect(getMapUrl({ venue: 'X', address: null, mapUrl: 'https://maps.app.goo.gl/abc' })).toBe('https://maps.app.goo.gl/abc');
    expect(getMapUrl({ venue: 'Casa', address: 'Rua A, 10', mapUrl: null })).toContain('query=Casa%2C%20Rua%20A%2C%2010');
  });
});
