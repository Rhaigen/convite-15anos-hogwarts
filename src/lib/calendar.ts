import type { EventInfo } from '../types/content';
import { getEventStart } from './date';

export interface CalendarEntry {
  title: string;
  description: string;
  location: string;
  allDay: boolean;
  /** Data (AAAA-MM-DD) para eventos de dia inteiro. */
  date: string;
  start: Date;
  end: Date;
}

export function toCalendarEntry(event: EventInfo): CalendarEntry {
  const start = getEventStart(event);
  return {
    title: `15 anos de ${event.celebrant}`,
    description: `Celebração dos 15 anos de ${event.celebrant}.`,
    location: [event.venue, event.address].filter(Boolean).join(' — '),
    allDay: event.time === null,
    date: event.date,
    start,
    end: new Date(start.getTime() + event.durationHours * 3_600_000),
  };
}

const compactDate = (iso: string) => iso.replace(/-/g, '');
const utcStamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function nextDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** Link "adicionar ao Google Agenda". */
export function googleCalendarUrl(entry: CalendarEntry): string {
  const dates = entry.allDay
    ? `${compactDate(entry.date)}/${compactDate(nextDay(entry.date))}`
    : `${utcStamp(entry.start)}/${utcStamp(entry.end)}`;
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: entry.title,
    dates,
    details: entry.description,
    location: entry.location,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** Escapa texto conforme RFC 5545 e quebra linhas longas (75 octetos). */
function icsText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function fold(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const out: string[] = [];
  let current = '';
  for (const char of line) {
    if (encoder.encode(current + char).length > (out.length === 0 ? 75 : 74)) {
      out.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  out.push(current);
  return out.join('\r\n ');
}

/** Arquivo iCalendar (.ics) compatível com Apple, Google e Outlook. */
export function buildIcs(entry: CalendarEntry, now = new Date()): string {
  const timing = entry.allDay
    ? [`DTSTART;VALUE=DATE:${compactDate(entry.date)}`, `DTEND;VALUE=DATE:${compactDate(nextDay(entry.date))}`]
    : [`DTSTART:${utcStamp(entry.start)}`, `DTEND:${utcStamp(entry.end)}`];
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Convite Sofia 15 anos//PT-BR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:sofia-15-anos-${compactDate(entry.date)}@convite`,
    `DTSTAMP:${utcStamp(now)}`,
    ...timing,
    `SUMMARY:${icsText(entry.title)}`,
    `DESCRIPTION:${icsText(entry.description)}`,
    `LOCATION:${icsText(entry.location)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

export function downloadIcs(entry: CalendarEntry): void {
  const blob = new Blob([buildIcs(entry)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sofia-15-anos.ics';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * URL de mapa somente quando houver dado real configurado:
 * link explícito (https) ou endereço completo. Caso contrário, `null`.
 */
export function getMapUrl(event: Pick<EventInfo, 'mapUrl' | 'address' | 'venue'>): string | null {
  if (event.mapUrl) {
    try {
      const url = new URL(event.mapUrl);
      return url.protocol === 'https:' ? url.toString() : null;
    } catch {
      return null;
    }
  }
  if (event.address && event.address.trim().length > 5) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${event.venue}, ${event.address}`)}`;
  }
  return null;
}
