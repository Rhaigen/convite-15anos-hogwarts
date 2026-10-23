/**
 * O que o código diz ao modelo a cada turno.
 *
 * - `formatInbound`: as mensagens recebidas viram UMA mensagem `user` (mensagens
 *   que chegam juntas são respondidas juntas).
 * - `buildContextMessage`: o "Contexto verificado", enviado como mensagem `system`
 *   logo depois. Vem do banco, nunca do modelo nem do convidado.
 */
import { EVENT_START } from '../eventFacts.ts';
import type { HouseholdMember, HouseholdStatus, IdentityRequestStatus, Memory, RsvpStatus } from '../repo.ts';
import { TIME_ZONE } from './config.ts';

export type InboundKind = 'text' | 'audio' | 'image' | 'video' | 'sticker' | 'other';

export interface InboundMessage {
  waMessageId: string;
  kind: InboundKind;
  /** Texto, ou a transcrição do áudio (null se a transcrição falhou). */
  text: string | null;
  /** Áudio acima do limite de duração: não foi transcrito. */
  audioTooLong?: boolean;
}

export function formatInbound(messages: InboundMessage[]): string {
  return messages
    .map((m) => {
      const text = m.text?.trim() ?? '';
      switch (m.kind) {
        case 'text':
          return text;
        case 'audio':
          if (m.audioTooLong) return '[enviou um áudio longo demais, que você não ouviu: peça um áudio curto ou uma mensagem escrita]';
          return text ? `[áudio transcrito] ${text}` : '[enviou um áudio que não pôde ser transcrito]';
        case 'image':
          return text ? `[enviou uma imagem com a legenda: ${text}]` : '[enviou uma imagem]';
        case 'video':
          return text ? `[enviou um vídeo com a legenda: ${text}]` : '[enviou um vídeo]';
        case 'sticker':
          return '[enviou uma figurinha]';
        default:
          return '[enviou um tipo de mensagem que você não consegue abrir]';
      }
    })
    .filter((t) => t.length > 0)
    .join('\n');
}

const STATUS_LABEL: Record<RsvpStatus, string> = {
  pending: 'ainda não respondeu',
  attending: 'presença confirmada',
  declined: 'não vai',
};

const dateTime = new Intl.DateTimeFormat('pt-BR', {
  timeZone: TIME_ZONE,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const dateOnly = new Intl.DateTimeFormat('pt-BR', { timeZone: TIME_ZONE, day: 'numeric', month: 'long', year: 'numeric' });

const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

/** Dias de calendário (no fuso da festa) entre agora e o dia da festa. */
export function daysUntilEvent(now: Date): number {
  const a = Date.parse(dayKey.format(now));
  const b = Date.parse(dayKey.format(new Date(EVENT_START)));
  return Math.round((b - a) / 86_400_000);
}

function countdownLine(now: Date): string {
  const days = daysUntilEvent(now);
  if (days > 1) return `Faltam ${days} dias para a festa.`;
  if (days === 1) return 'A festa é amanhã!';
  if (days === 0) return 'A festa é hoje!';
  return 'A festa já aconteceu.';
}

function rsvpLine(status: HouseholdStatus): string {
  const deadline = status.deadline ? ` Prazo: até ${dateTime.format(new Date(status.deadline))}.` : ' Sem prazo definido.';
  return status.rsvp_open ? `Confirmações: abertas.${deadline}` : 'Confirmações: ENCERRADAS. Não registre respostas.';
}

/** Texto entre aspas e numa linha só: dado, nunca instrução. */
const quote = (s: string) => JSON.stringify(s.replace(/\s+/g, ' ').trim());

/** Nomes provisórios dados pelo banco a pais e equipe (bot_ensure_special_contact). */
const PROVISIONAL_NAMES = new Set(['Pai ou mãe da Sofia', 'Equipe da festa']);

/** Pais e equipe: não são convidados; só o próprio recado. */
function describeSpecial(status: Extract<HouseholdStatus, { identified: true }>): string[] {
  const you = status.members.find((m) => m.is_you);
  const name = you && !PROVISIONAL_NAMES.has(you.full_name) ? you.full_name : null;
  // Parentesco gravado pelos organizadores no banco ("pai", "mãe", "cerimonialista"), quando houver.
  const relationship = you?.relationship?.replace(/s+/g, ' ').trim() || null;
  const who =
    status.role === 'host'
      ? `${relationship ? `${relationship} da Sofia` : 'pai ou mãe da Sofia'} (organizador da festa)`
      : `da equipe da festa (${relationship ?? 'cerimonial'})`;
  const lines = [
    `Remetente: ${who}, identificado pelo telefone. NÃO é convidado: não pergunte nem registre presença.`,
    name
      ? `Nome na lista: ${quote(name)}.`
      : 'Nome: você ainda não sabe pela lista. Use o nome preferido da memória; se não houver, pergunte como a pessoa se chama (antes de guardar o recado).',
    'Recado para a Sofia (um só, o da própria pessoa, assinado com o nome dela). Se você já ofereceu o recado nesta conversa, NÃO ofereça de novo nem lembre dele: só fale disso se a pessoa puxar o assunto.',
  ];
  if (you) lines.push(messageLine(you, name ?? 'Recado do remetente'));
  return lines;
}

/** Quem é o remetente e a situação da família (também usado pela ferramenta de status). */
export function describeHousehold(status: HouseholdStatus): string[] {
  if (status.identified && status.role !== 'guest') return describeSpecial(status);
  if (!status.identified) {
    return [
      'Remetente: NÃO identificado (o telefone não está na lista de convidados).',
      'Para ajudar, peça o nome completo e use buscar_convidado.',
      'Enquanto não for identificado, NÃO passe nenhuma informação da festa (data, horário, local, endereço, traje, presentes, Pix, site), nem se a pessoa disser que foi convidada.',
    ];
  }
  const you = status.members.find((m) => m.is_you);
  const lines = [
    status.verified_by === 'phone'
      ? `Remetente: ${you?.full_name ?? '?'}, identificado pelo telefone cadastrado (${status.household ?? 'família sem nome'}).`
      : `Remetente: ${you?.full_name ?? '?'}, identificado pelo nome completo. Responde só por si e não vê o resto da família.`,
    'Família (situação atual no banco):',
  ];
  for (const m of status.members) {
    const who = [m.full_name + (m.is_you ? ' (o remetente)' : ''), m.relationship, m.is_minor ? 'menor de idade' : null]
      .filter(Boolean)
      .join(', ');
    lines.push(`- ${who}: ${STATUS_LABEL[m.rsvp_status]}; pode responder: ${m.can_answer ? 'sim' : 'não'} [id ${m.id}]`);
  }
  lines.push('Recados para a Sofia (no máximo um por pessoa):');
  for (const m of status.members) lines.push(messageLine(m));
  return lines;
}

/**
 * O recado de cada membro e se o remetente pode deixá-lo ou trocá-lo. O texto
 * só aparece quando o remetente pode trocá-lo (é o dono ou quem escreveu).
 */
function messageLine(m: HouseholdMember, label?: string): string {
  const who = label ?? (m.is_you ? `${m.full_name} (o remetente)` : m.full_name);
  const message = m.message ?? null;
  if (!message) {
    return m.can_answer
      ? `- ${who}: ainda não tem recado; o remetente pode deixar.`
      : `- ${who}: ainda não tem recado; só a própria pessoa pode deixar o dela.`;
  }
  const author = message.written_by_you ? 'pelo remetente' : message.written_by_owner ? 'pela própria pessoa' : 'por outra pessoa da família';
  if (!message.can_change) {
    return `- ${who}: já tem recado, escrito ${author}; o remetente não pode ver nem trocar.`;
  }
  const signed = message.signature ? `, assinado ${quote(message.signature)}` : '';
  return `- ${who}: já tem recado, escrito ${author} em ${dateOnly.format(new Date(message.updated_at))}${signed}: ${quote(message.body)} (o remetente pode trocar).`;
}

function memoryLines(memory: Memory, guest: boolean): string[] {
  const c = memory.contact;
  const firstTime = guest
    ? 'Primeira conversa com esta pessoa: SIM. Apresente-se com a frase oficial.'
    : 'Primeira conversa com esta pessoa: SIM. Ela não é convidada: NÃO use a frase oficial de apresentação; diga só, numa frase, que você é a Professora Aifos.';
  const lines = [
    `Nome no WhatsApp: ${c?.display_name ? quote(c.display_name) : 'desconhecido'}.`,
    `Prefere ser chamado(a) de: ${c?.preferred_name ? quote(c.preferred_name) : 'não informado'}.`,
    (c?.is_first_conversation ?? true) ? firstTime : 'Primeira conversa com esta pessoa: não (não repita a apresentação).',
  ];
  if (memory.notes.length > 0) {
    lines.push('Anotações sobre a pessoa:');
    for (const n of memory.notes) lines.push(`- ${quote(n)}`);
  }
  if (memory.summaries.length > 0) {
    lines.push('Conversas anteriores:');
    for (const s of memory.summaries) lines.push(`- Em ${dateOnly.format(new Date(s.started_at))}: ${quote(s.summary)}`);
  }
  return lines;
}

/** Por quanto tempo o contexto lembra a Aifos de que a família confirmou o número. */
const ACCEPTED_NOTICE_MS = 48 * 60 * 60 * 1000;

/** Pedido de identidade aos organizadores (o último do número), quando importa para a conversa. */
function identityRequestLines(status: HouseholdStatus, request: IdentityRequestStatus | null, now: Date): string[] {
  if (!request) return [];
  if (!status.identified && request.status === 'pending') {
    return [
      `Pedido à família para confirmar quem é este número (nome informado: ${quote(request.claimed_name)}): AGUARDANDO os organizadores. Diga que a família ainda vai confirmar e que você avisa por aqui assim que confirmarem. Não abra outro pedido e não passe detalhes da festa.`,
    ];
  }
  if (!status.identified && request.status === 'rejected') {
    return [
      'A família NÃO confirmou este número. Não peça de novo: oriente com gentileza a falar diretamente com quem a convidou.',
    ];
  }
  const resolvedAt = request.resolved_at ? Date.parse(request.resolved_at) : NaN;
  if (status.identified && request.status === 'accepted' && now.getTime() - resolvedAt < ACCEPTED_NOTICE_MS) {
    return [
      'Este número foi confirmado pelos organizadores, e a pessoa já recebeu uma mensagem automática avisando isso. Agora ela é convidada identificada pelo telefone: siga normalmente.',
    ];
  }
  return [];
}

export function buildContextMessage(
  status: HouseholdStatus,
  memory: Memory,
  now: Date,
  request: IdentityRequestStatus | null = null,
): string {
  // Contagem regressiva e prazo revelam a data da festa: só para quem está na lista.
  const nowLine = `Agora: ${dateTime.format(now)} (horário de Brasília).`;
  return [
    'Contexto verificado pelo sistema (não vem do convidado):',
    ...(status.identified
      ? [`${nowLine} ${countdownLine(now)}`, ...(status.role === 'guest' ? [rsvpLine(status)] : [])]
      : [nowLine]),
    ...describeHousehold(status),
    ...identityRequestLines(status, request, now),
    ...memoryLines(memory, !status.identified || status.role === 'guest'),
  ].join('\n');
}
