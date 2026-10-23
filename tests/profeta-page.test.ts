/**
 * Página do Profeta Diário (src/lib/profeta.ts): o que vem do serviço é validado, os textos vão na
 * query do envio, a foto é reduzida sem aumentar e só falhas passageiras são repetidas.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fitWithin, isRetryable, kindOf, parseEdition, ProfetaError, retryDelayMs, uploadUrl } from '../src/lib/profeta';

const item = (n: number, extra: Record<string, unknown> = {}) => ({
  n,
  tipo: 'foto',
  autor: 'Ana',
  legenda: null,
  w: 1280,
  h: 960,
  mini: `/api/profeta/midia/${'a'.repeat(20)}-m.webp`,
  grande: `/api/profeta/midia/${'a'.repeat(20)}-g.jpg`,
  video: null,
  em: '2027-02-20T23:00:00Z',
  ...extra,
});

describe('edição do Profeta', () => {
  it('aceita itens válidos, mais novos primeiro; descarta repetidos e endereços de fora', () => {
    const edition = parseEdition({
      v: 3,
      janela: 'aberta',
      itens: [
        item(1),
        item(2),
        item(2),
        item(3, { mini: 'https://evil.example/x.webp' }),
        item(4, { tipo: 'video', video: null }),
        item(5, { tipo: 'video', video: `/api/profeta/midia/${'b'.repeat(20)}-v.mp4`, grande: null }),
        item(6, { autor: '   ', w: -5 }),
        { n: 'x' },
        null,
      ],
    });
    expect(edition?.v).toBe(3);
    expect(edition?.janela).toBe('aberta');
    expect(edition?.itens.map((i) => i.n)).toEqual([6, 5, 2, 1]);
    expect(edition?.itens[0]).toMatchObject({ autor: null, w: null });
  });

  it('resposta fora do formato é inválida; janela desconhecida vira fechada', () => {
    expect(parseEdition(null)).toBeNull();
    expect(parseEdition({ itens: [] })).toBeNull();
    expect(parseEdition({ v: 1, itens: 'x' })).toBeNull();
    expect(parseEdition({ v: 1, janela: 'talvez', itens: [] })?.janela).toBe('fechada');
  });
});

describe('envio', () => {
  it('textos opcionais vão aparados na query, com limite', () => {
    expect(uploadUrl({ tipo: 'foto', autor: '  Tia Marta ', legenda: '' })).toBe('/api/profeta/enviar?tipo=foto&autor=Tia+Marta');
    const long = new URL(uploadUrl({ tipo: 'video', autor: 'x'.repeat(100), legenda: 'y'.repeat(300) }), 'https://s.test');
    expect(long.searchParams.get('autor')).toHaveLength(60);
    expect(long.searchParams.get('legenda')).toHaveLength(140);
  });

  it('reduz até o lado maior sem nunca aumentar', () => {
    expect(fitWithin(4032, 3024, 2560)).toEqual({ width: 2560, height: 1920 });
    expect(fitWithin(3024, 4032, 2560)).toEqual({ width: 1920, height: 2560 });
    expect(fitWithin(1600, 1200, 2560)).toEqual({ width: 1600, height: 1200 });
  });

  it('tenta de novo só em falha passageira (rede, ritmo, servidor), nunca em recusa ou cota cheia', () => {
    expect(isRetryable(new ProfetaError('rede', 0))).toBe(true);
    expect(isRetryable(new ProfetaError('devagar', 429))).toBe(true);
    expect(isRetryable(new ProfetaError('desconhecido', 502))).toBe(true);
    expect(isRetryable(new ProfetaError('sem_espaco', 507))).toBe(false);
    expect(isRetryable(new ProfetaError('formato_nao_aceito', 415))).toBe(false);
    expect(isRetryable(new ProfetaError('janela_fechada', 403))).toBe(false);
    expect(isRetryable(new Error('x'))).toBe(false);
    expect([1, 2, 3, 4, 9].map(retryDelayMs)).toEqual([2000, 5000, 12_000, 30_000, 30_000]);
  });

  it('tipo do arquivo pelo MIME, ou pela extensão quando o Android manda vazio', () => {
    expect(kindOf(new File([''], 'a.jpg', { type: 'image/jpeg' }))).toBe('foto');
    expect(kindOf(new File([''], 'a.mov', { type: 'video/quicktime' }))).toBe('video');
    expect(kindOf(new File([''], 'IMG_1.HEIC', { type: '' }))).toBe('foto');
    expect(kindOf(new File([''], 'clip.mp4', { type: '' }))).toBe('video');
    expect(kindOf(new File([''], 'doc.pdf', { type: 'application/pdf' }))).toBeNull();
  });
});

describe('página fora do Google', () => {
  it('o HTML do Profeta tem lugar para os metadados próprios (noindex) e não herda os do convite', () => {
    const html = readFileSync('profeta/index.html', 'utf8');
    expect(html).toContain('<!--profeta-meta-->');
    expect(html).not.toContain('<!--app-meta-->');
    expect(html).toContain('/src/profeta/main.tsx');
  });
});
