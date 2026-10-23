import type { EventInfo } from '../types/content.ts';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const OFFSET_RE = /^[+-](0\d|1[0-4]):[0-5]\d$/;

/** Instante de início da festa, considerando horário e fuso configurados. */
export function getEventStart(event: Pick<EventInfo, 'date' | 'time' | 'utcOffset'>): Date {
  if (!DATE_RE.test(event.date)) throw new Error(`Data do evento inválida: ${event.date}`);
  if (event.time !== null && !TIME_RE.test(event.time)) throw new Error(`Horário inválido: ${event.time}`);
  if (!OFFSET_RE.test(event.utcOffset)) throw new Error(`Fuso inválido: ${event.utcOffset}`);
  return new Date(`${event.date}T${event.time ?? '00:00'}:00${event.utcOffset}`);
}

/** Fim do dia da festa no fuso do evento — usado para mensagens pós-evento. */
export function getEventDayEnd(event: Pick<EventInfo, 'date' | 'utcOffset'>): Date {
  return new Date(new Date(`${event.date}T00:00:00${event.utcOffset}`).getTime() + 86_400_000);
}

function calendarDate(isoDate: string): Date {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, 12));
}

const fmt = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', ...options });

/** "sábado, 20 de fevereiro de 2027" */
export function formatDateLong(isoDate: string): string {
  return fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(calendarDate(isoDate));
}

/** "20 de fevereiro de 2027" */
export function formatDateMedium(isoDate: string): string {
  return fmt({ day: 'numeric', month: 'long', year: 'numeric' }).format(calendarDate(isoDate));
}

/** "20/02/2027" */
export function formatDateShort(isoDate: string): string {
  return fmt({ day: '2-digit', month: '2-digit', year: 'numeric' }).format(calendarDate(isoDate));
}

export interface DateParts {
  weekday: string;
  day: string;
  month: string;
  year: string;
}

/** Partes da data para composições tipográficas (calendário, encerramento). */
export function getDateParts(isoDate: string): DateParts {
  const date = calendarDate(isoDate);
  return {
    weekday: fmt({ weekday: 'long' }).format(date),
    day: fmt({ day: '2-digit' }).format(date),
    month: fmt({ month: 'long' }).format(date),
    year: fmt({ year: 'numeric' }).format(date),
  };
}

/** "20h" / "20h30" — formato usual em convites brasileiros. */
export function formatTime(time: string): string {
  const [h, m] = time.split(':');
  return m === '00' ? `${Number(h)}h` : `${Number(h)}h${m}`;
}

const ROMAN: [number, string][] = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
  [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];

export function toRoman(value: number): string {
  let n = Math.floor(value);
  let out = '';
  for (const [v, s] of ROMAN) {
    while (n >= v) {
      out += s;
      n -= v;
    }
  }
  return out;
}
