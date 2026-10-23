export type CountdownStatus = 'upcoming' | 'today' | 'past';

export interface CountdownState {
  status: CountdownStatus;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

/**
 * Tempo restante calculado SEMPRE a partir do instante de destino
 * (nunca decrementando um valor armazenado), imune a atrasos do timer.
 */
export function computeCountdown(target: Date, dayEnd: Date, now: number): CountdownState {
  const diff = target.getTime() - now;
  if (diff <= 0) {
    return { status: now < dayEnd.getTime() ? 'today' : 'past', days: 0, hours: 0, minutes: 0, seconds: 0 };
  }
  const totalSeconds = Math.floor(diff / 1000);
  return {
    status: 'upcoming',
    days: Math.floor(totalSeconds / 86_400),
    hours: Math.floor((totalSeconds % 86_400) / 3_600),
    minutes: Math.floor((totalSeconds % 3_600) / 60),
    seconds: totalSeconds % 60,
  };
}

const LABELS = {
  days: ['dia', 'dias'],
  hours: ['hora', 'horas'],
  minutes: ['minuto', 'minutos'],
  seconds: ['segundo', 'segundos'],
} as const;

export type CountdownUnit = keyof typeof LABELS;

export function unitLabel(unit: CountdownUnit, value: number): string {
  return LABELS[unit][value === 1 ? 0 : 1];
}

/** Resumo para leitores de tela, ex.: "Faltam 130 dias, 4 horas e 12 minutos." */
export function describeCountdown(state: CountdownState): string {
  const parts = (['days', 'hours', 'minutes'] as const)
    .filter((u) => state[u] > 0 || u === 'minutes')
    .map((u) => `${state[u]} ${unitLabel(u, state[u])}`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1]}` : parts[0];
  return `Faltam ${list} para a celebração.`;
}
