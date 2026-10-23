/**
 * Os fatos da festa que a Aifos conhece são gerados de src/content/ para dentro
 * de supabase/functions (as Edge Functions não importam arquivos de fora). Este
 * teste falha se o arquivo gerado ficar desatualizado: rode `npm run agent:facts`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildEventFacts, renderEventFactsModule } from '../scripts/lib/agent-facts.ts';
import { event } from '../src/content/event.ts';
import { EVENT_START } from '../supabase/functions/_shared/eventFacts.ts';
import { FAREWELL, INTRO_PHRASE, SYSTEM_PROMPT } from '../supabase/functions/_shared/agent/prompt.ts';
import { daysUntilEvent } from '../supabase/functions/_shared/agent/context.ts';

describe('fatos da festa', () => {
  it('o arquivo gerado está em dia com src/content (senão: npm run agent:facts)', () => {
    const committed = readFileSync('supabase/functions/_shared/eventFacts.ts', 'utf8').replace(/\r\n/g, '\n');
    expect(committed).toBe(renderEventFactsModule());
  });

  it('não vaza null/undefined e marca o que falta como pendente', () => {
    const facts = buildEventFacts().join('\n');
    expect(facts).not.toMatch(/\bnull\b|\bundefined\b/);
    expect(facts).toContain(`Traje: ${event.dressCode ?? 'a família ainda vai informar'}.`);
    // Sem siteMeta.url, a Aifos não inventa link: diz que a família vai divulgar.
    expect(facts).toMatch(/Site do convite: (https:\/\/\S+ |ainda não está no ar)/);
    expect(facts).toContain('Cerimonial Casa de Pedra Slim');
  });

  it('o prompt tem a apresentação e a despedida, mas nenhum fato da festa', () => {
    expect(SYSTEM_PROMPT).toContain(INTRO_PHRASE);
    expect(SYSTEM_PROMPT).toContain(FAREWELL);
    // Os fatos só chegam pela ferramenta ver_detalhes_da_festa, liberada para quem está na lista.
    expect(SYSTEM_PROMPT).not.toMatch(/Amazonas|Casa de Pedra|Vila Velha|20h|fevereiro|2027/);
    expect(SYSTEM_PROMPT).toContain('ver_detalhes_da_festa');
  });

  it('contagem de dias no fuso da festa', () => {
    expect(EVENT_START).toBe('2027-02-20T23:00:00.000Z');
    // 23h de 19/02 em Brasília ainda é véspera, embora já seja 20/02 em UTC.
    expect(daysUntilEvent(new Date('2027-02-20T02:00:00Z'))).toBe(1);
    expect(daysUntilEvent(new Date('2027-02-20T12:00:00Z'))).toBe(0);
    expect(daysUntilEvent(new Date('2027-02-22T12:00:00Z'))).toBe(-2);
  });
});
