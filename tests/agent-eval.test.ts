/**
 * Guarda dos cenários do `npm run agent:eval` (que usa o Haiku real e não roda
 * aqui): cenários bem formados e checagens que acusam o que devem acusar.
 */
import { describe, expect, it } from 'vitest';
import {
  asksFirst,
  messageNotSavedIn,
  messageSaved,
  neverSays,
  noMessages,
  noRequest,
  reacted,
  requestOpened,
  says,
  SCENARIOS,
  status,
  type Observation,
  type TurnObservation,
} from '../scripts/lib/agent-eval-scenarios.ts';
import { DEMO_GUESTS, DEMO_PHONES } from '../scripts/lib/pglite-db.ts';

const names = new Set(DEMO_GUESTS.map((g) => g.full_name));

const turn = (over: Partial<TurnObservation>): TurnObservation => ({
  who: 'carlos',
  said: 'oi',
  text: '',
  tools: [],
  reaction: null,
  changes: [],
  forwards: [],
  identityRequests: 0,
  outcome: 'replied',
  ...over,
});

describe('cenários do agent:eval', () => {
  it('têm ids únicos, remetentes e convidados que existem', () => {
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
    for (const s of SCENARIOS) {
      expect(s.checks.length, s.id).toBeGreaterThan(0);
      for (const step of s.steps) if ('as' in step) expect(DEMO_PHONES, s.id).toHaveProperty(step.as);
      for (const name of Object.keys({ ...s.preset, ...s.presetMessages })) expect(names, `${s.id}: ${name}`).toContain(name);
      // status('Nome', 'x') vira o rótulo "Nome: x".
      for (const c of s.checks) {
        const m = c.label.match(/^(.+): (pending|attending|declined)$/);
        if (m) expect(names, `${s.id}: ${m[1]}`).toContain(m[1]);
      }
    }
  });

  it('as checagens acusam o que devem', () => {
    const changed = { guest_id: 'x', full_name: 'Carlos Souza', previous_status: 'pending', rsvp_status: 'attending' } as never;
    const o: Observation = {
      turns: [turn({ text: 'Confirmo então?' }), turn({ text: 'Feito! Nos vemos na noite mais mágica do ano!', changes: [changed], reaction: '❤️' })],
      statuses: { 'Carlos Souza': 'attending' },
      linked: {},
      messages: {},
      requests: [],
    };
    expect(status('Carlos Souza', 'attending').test(o)).toBe(true);
    expect(status('Carlos Souza', 'declined').test(o)).toMatch(/ficou attending/);
    expect(asksFirst(1).test(o)).toBe(true);
    expect(asksFirst(2).test(o)).toMatch(/gravou já/);
    expect(reacted('❤️').test(o)).toBe(true);
    expect(reacted('😢').test(o)).toMatch(/reação: ❤️/);
    expect(says('despedida', /noite mais m[áa]gica/i, 2).test(o)).toBe(true);
    expect(neverSays('despedida', /noite mais m[áa]gica/i, 1).test(o)).toBe(true);
    expect(neverSays('despedida', /noite mais m[áa]gica/i).test(o)).toMatch(/encontrou/);
  });

  it('as checagens de recado acusam o que devem', () => {
    const o: Observation = {
      turns: [turn({ text: 'Guardo assim?' }), turn({ text: 'Guardado!', tools: [{ name: 'guardar_recado', input: {} }] })],
      statuses: {},
      linked: {},
      messages: { 'Marta Souza': { body: 'Que essa nova fase seja linda', signature: null, source: 'audio', by: 'Marta Souza' } },
      requests: [],
    };
    expect(messageSaved('Marta Souza', /nova fase/i, { source: 'audio' }).test(o)).toBe(true);
    expect(messageSaved('Marta Souza', /nova fase/i, { source: 'text' }).test(o)).toMatch(/origem audio/);
    expect(messageSaved('Carlos Souza', /x/).test(o)).toMatch(/nenhum recado/);
    expect(messageSaved('Marta Souza', /nova fase/i, { by: 'Carlos Souza' }).test(o)).toMatch(/escrito por Marta Souza/);
    expect(noMessages().test(o)).toMatch(/Marta Souza/);
    expect(messageNotSavedIn(1).test(o)).toBe(true);
    expect(messageNotSavedIn(2).test(o)).toMatch(/turno 2/);
  });

  it('as checagens de pedido aos organizadores acusam o que devem', () => {
    const o = (requests: Observation['requests']): Observation => ({ turns: [turn({})], statuses: {}, linked: {}, messages: {}, requests });
    const carlos = { who: 'desconhecido' as const, claimed_name: 'Carlos Souza', guest_name: 'Carlos Souza', status: 'pending' as const };
    expect(requestOpened('Carlos Souza').test(o([carlos]))).toBe(true);
    expect(requestOpened(null).test(o([carlos]))).toMatch(/convidado Carlos Souza/);
    expect(requestOpened('Carlos Souza').test(o([carlos, carlos]))).toMatch(/2 pedidos/);
    expect(noRequest().test(o([]))).toBe(true);
    expect(noRequest().test(o([carlos]))).toMatch(/Carlos Souza/);
  });

  it('"já confirmado" reconhece frases com acento (o \\b do JS não serve)', () => {
    const check = SCENARIOS.find((s) => s.id === 'ja-confirmado')!.checks[0]!;
    const obs = (text: string): Observation => ({ turns: [turn({ text })], statuses: {}, linked: {}, messages: {}, requests: [] });
    expect(check.test(obs('A sua presença já está confirmada, Carlos!'))).toBe(true);
    expect(check.test(obs('Já encontrei a sua confirmação no pergaminho.'))).toBe(true);
    expect(check.test(obs('Quer confirmar a sua presença?'))).not.toBe(true);
  });
});
