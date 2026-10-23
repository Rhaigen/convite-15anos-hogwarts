/**
 * Relatório dos organizadores: texto DETERMINÍSTICO a partir de public.bot_report().
 * Nenhuma IA envolvida: as contagens e os nomes vêm direto do banco.
 */
import type { IdentityRequest, RsvpStatus } from '../repo.ts';
import { TIME_ZONE } from '../agent/config.ts';
import { formatBRL } from '../gifts/pricing.ts';
import { formatPhone } from './phone.ts';
import type { ProfetaRemoval, ProfetaSummary } from './profeta.ts';

export interface ReportData {
  generated_at: string;
  rsvp_open: boolean;
  deadline: string | null;
  totals: { guests: number; attending: number; declined: number; pending: number; attending_minors: number };
  /** Recados para a Sofia (sem os ocultos). */
  messages?: { total: number; last_24h: number; awaiting_approval?: number };
  households: {
    label: string;
    members: { full_name: string; is_minor: boolean; rsvp_status: RsvpStatus; rsvp_updated_at: string | null }[] | null;
  }[];
}

const dateTime = new Intl.DateTimeFormat('pt-BR', {
  timeZone: TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const SECTIONS: { status: RsvpStatus; title: string }[] = [
  { status: 'attending', title: '✅ *Confirmados*' },
  { status: 'declined', title: '❌ *Não vão*' },
  { status: 'pending', title: '⏳ *Sem resposta*' },
];

const CHANGE_LABEL: Record<RsvpStatus, string> = {
  attending: 'confirmou presença',
  declined: 'não vai',
  pending: 'voltou para sem resposta',
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Mensagens do relatório (uma por seção, para ler no celular): resumo e
 * novidades das últimas 24 h, depois confirmados, recusas e pendentes por família.
 */
export function formatReport(report: ReportData, kind: 'on_demand' | 'daily' = 'on_demand'): string[] {
  const t = report.totals;
  const generated = new Date(report.generated_at);
  const deadline = report.deadline ? dateTime.format(new Date(report.deadline)) : null;

  const header = [
    kind === 'daily' ? '🦉 *Relatório diário da Professora Aifos*' : '📜 *Relatório da Professora Aifos*',
    dateTime.format(generated),
    '',
    `✅ Confirmados: *${t.attending}*${t.attending_minors > 0 ? ` (${plural(t.attending_minors, 'menor', 'menores')})` : ''}`,
    `❌ Não vão: *${t.declined}*`,
    `⏳ Sem resposta: *${t.pending}*`,
    `👥 Na lista: ${plural(t.guests, 'convidado', 'convidados')}`,
    report.rsvp_open
      ? deadline
        ? `Confirmações abertas até ${deadline}.`
        : 'Confirmações abertas, sem prazo definido.'
      : 'Confirmações *encerradas*.',
  ];
  if (report.messages) {
    const { total, last_24h, awaiting_approval = 0 } = report.messages;
    header.push(`💌 Recados para a Sofia: *${total}*${last_24h > 0 ? ` (${last_24h} nas últimas 24 h)` : ''}`);
    if (awaiting_approval > 0) {
      header.push(`🕯️ Aguardando aprovação para o Salão do site: *${awaiting_approval}* (mande *recados*)`);
    }
  }

  const since = generated.getTime() - 24 * 60 * 60 * 1000;
  const recent = report.households
    .flatMap((h) => (h.members ?? []).map((m) => ({ ...m, household: h.label })))
    .filter((m) => m.rsvp_updated_at && new Date(m.rsvp_updated_at).getTime() >= since)
    .sort((a, b) => Date.parse(a.rsvp_updated_at!) - Date.parse(b.rsvp_updated_at!));
  if (recent.length > 0) {
    header.push('', '🆕 *Últimas 24 horas*');
    for (const m of recent) header.push(`• ${m.full_name} (${m.household}): ${CHANGE_LABEL[m.rsvp_status]}`);
  } else if (kind === 'daily') {
    header.push('', 'Nenhuma resposta nova nas últimas 24 horas.');
  }

  const messages = [header.join('\n')];
  for (const { status, title } of SECTIONS) {
    const lines: string[] = [];
    let count = 0;
    for (const h of report.households) {
      const names = (h.members ?? [])
        .filter((m) => m.rsvp_status === status)
        .map((m) => (m.is_minor ? `${m.full_name} (menor)` : m.full_name));
      if (names.length === 0) continue;
      count += names.length;
      lines.push(`• *${h.label}*: ${names.join(', ')}`);
    }
    if (count > 0) messages.push([`${title} (${count})`, ...lines].join('\n'));
  }
  return messages;
}

/** Recado como sai de public.bot_guest_messages(). */
export interface GuestMessageEntry {
  /** Número do recado nos comandos "publicar N" / "retirar N". */
  id?: number;
  full_name: string;
  household: string;
  signature: string | null;
  body: string;
  source: 'text' | 'audio';
  /** Aprovado para o Salão Principal do site. */
  approved?: boolean;
  /** Quem enviou pela Aifos, quando não foi o próprio dono (um responsável pela família). */
  sent_by?: string | null;
  created_at: string;
  updated_at: string;
}

const dayMonth = new Intl.DateTimeFormat('pt-BR', { timeZone: TIME_ZONE, day: '2-digit', month: '2-digit' });

/** Tamanho máximo de cada mensagem do comando "recados" (leitura confortável no celular). */
export const MESSAGES_CHUNK_CHARS = 3500;

/**
 * Comando "recados": todos os recados, por ordem de chegada, em várias
 * mensagens quando passam do tamanho confortável. Sem IA. Cada um traz o número
 * e se já está no Salão Principal do site; no fim, como publicar ou retirar.
 */
export function formatGuestMessages(entries: GuestMessageEntry[], chunkChars = MESSAGES_CHUNK_CHARS): string[] {
  if (entries.length === 0) return ['💌 Ainda não chegou nenhum recado para a Sofia.'];

  const blocks = entries.map((m) => {
    const details = [
      m.household,
      m.signature && m.signature !== m.full_name ? `assinado "${m.signature}"` : null,
      m.sent_by ? `enviado por ${m.sent_by}` : null,
      m.source === 'audio' ? 'por áudio 🎙️' : null,
      dayMonth.format(new Date(m.updated_at)),
    ].filter(Boolean);
    const number = m.id === undefined ? '' : `#${m.id} · `;
    const wall = m.approved === undefined ? '' : m.approved ? ' ✅ no Salão' : ' ⏳ aguardando';
    return `*${number}${m.full_name}* (${details.join(' · ')})${wall}\n${m.body}`;
  });
  const numbered = entries.filter((m) => m.id !== undefined && m.approved !== undefined);
  if (numbered.length > 0) {
    const waiting = numbered.filter((m) => !m.approved);
    const example = (waiting[0] ?? numbered[0])!.id;
    blocks.push(
      `🕯️ *Salão do site*: ${numbered.length - waiting.length} pendurado(s), ${waiting.length} aguardando.\n` +
        `Para pendurar: *publicar ${example}*. Para tirar: *retirar ${example}*.`,
    );
  }

  return chunkBlocks(`💌 *Recados para a Sofia* (${entries.length})`, blocks, chunkChars);
}

/** Junta o título e os blocos em mensagens de até `chunkChars` (sem partir um bloco). */
function chunkBlocks(title: string, blocks: string[], chunkChars: number): string[] {
  const messages: string[] = [];
  let current = title;
  for (const block of blocks) {
    if (current.length + 2 + block.length > chunkChars) {
      messages.push(current);
      current = block;
    } else {
      current += `\n\n${block}`;
    }
  }
  messages.push(current);
  return messages;
}

/** Um presente pago, de public.bot_gift_report() (só para os organizadores). */
export interface GiftReportEntry {
  gift_name: string;
  kind: 'quota' | 'fund';
  status: 'paid' | 'refunded';
  payment_method: 'pix' | 'card' | null;
  base_cents: number;
  payer_name: string | null;
  signature: string | null;
  anonymous: boolean;
  has_message: boolean;
  paid_at: string | null;
}

/**
 * Comando "presentes": quem deu cada presente, por ordem de pagamento. O nome de quem pagou
 * é o do cliente no Asaas e só sai por aqui (nunca no site, no Salão, no livro ou pela Aifos).
 */
export function formatGiftReport(entries: GiftReportEntry[], chunkChars = MESSAGES_CHUNK_CHARS): string[] {
  if (entries.length === 0) return ['🎁 Ainda nenhum presente pago pela lista do site.'];
  const paid = entries.filter((g) => g.status === 'paid');
  const total = paid.reduce((sum, g) => sum + g.base_cents, 0);

  const blocks = entries.map((g) => {
    const details = [
      formatBRL(g.base_cents),
      g.kind === 'fund' ? 'vaquinha' : null,
      g.payment_method === 'pix' ? 'Pix' : g.payment_method === 'card' ? 'cartão' : null,
      g.paid_at ? dayMonth.format(new Date(g.paid_at)) : null,
    ].filter(Boolean);
    const message = !g.has_message ? null : g.anonymous ? '💌 recado em segredo' : `💌 recado assinado "${g.signature}"`;
    const lines = [
      `*${g.gift_name}* (${details.join(' · ')})${g.status === 'refunded' ? ' ↩️ estornado' : ''}`,
      `De: ${g.payer_name ?? 'nome não recebido (veja no painel do Asaas)'}`,
      message,
    ];
    return lines.filter(Boolean).join('\n');
  });
  const title = `🎁 *Presentes pela lista* (${paid.length} pago${paid.length === 1 ? '' : 's'} · ${formatBRL(total)} para a família)\n_Só os organizadores veem os nomes._`;
  return chunkBlocks(title, blocks, chunkChars);
}

/** Resposta de public.bot_set_message_approval(). */
export type ApprovalResult = { ok: true; approved: boolean; from: string } | { ok: false; error: 'not_found' | 'hidden' };

/** Resposta aos comandos "publicar N" / "retirar N" (só depois que o banco aceitou). */
export function formatApproval(id: number, approved: boolean, result: ApprovalResult): string {
  if (!result.ok) {
    return result.error === 'hidden'
      ? `O recado #${id} está oculto e não pode ir para o Salão do site.`
      : `Não encontrei o recado #${id}. Mande *recados* para ver os números.`;
  }
  return approved
    ? `🕯️ Carta #${id} (de ${result.from}) pendurada no Salão do site. Ela aparece em até 1 minuto.`
    : `Carta #${id} (de ${result.from}) retirada do Salão do site.`;
}

/** Convidado parecido com o nome informado (public.bot_suggest_guest_names), só para os organizadores. */
export interface GuestSuggestion {
  full_name: string;
  household: string | null;
}

/** Linhas "• *aceitar N Nome*": o organizador manda a da pessoa certa. */
function suggestionLines(id: number, suggestions: GuestSuggestion[]): string[] {
  return suggestions.map((s) => `• *aceitar ${id} ${s.full_name}*${s.household ? ` (${s.household})` : ''}`);
}

/**
 * Aviso numerado de um pedido de identidade: os organizadores respondem
 * "aceitar N" (com o nome do convidado, se a busca não achou ninguém) ou "recusar N".
 * Sem convidado sugerido pela busca, mostra os nomes mais parecidos da lista, se houver.
 */
export function formatIdentityRequest(r: IdentityRequest, suggestions: GuestSuggestion[] = []): string {
  const who = `${formatPhone(r.phone)}${r.display_name ? ` ("${r.display_name}" no WhatsApp)` : ''}`;
  const title = `⚠️ *Pedido #${r.id} da Professora Aifos*`;
  if (r.guest_name) {
    const listed = r.guest_phone ? formatPhone(r.guest_phone) : 'sem telefone';
    return [
      title,
      `O número ${who} disse ser *${r.claimed_name}*.`,
      `Na lista, *${r.guest_name}*${r.household ? ` (${r.household})` : ''} tem outro telefone: ${listed}.`,
      '',
      `Se for essa pessoa, o número novo substitui o da lista: *aceitar ${r.id}*`,
      `Se não for: *recusar ${r.id}*`,
    ].join('\n');
  }
  return [
    title,
    `O número ${who} disse se chamar *${r.claimed_name}*, mas não encontrei esse nome na lista de convidados.`,
    '',
    ...(suggestions.length > 0
      ? [
          'Nomes parecidos na lista (mande a linha da pessoa certa):',
          ...suggestionLines(r.id, suggestions),
          '',
          `Se for outro convidado, mande o nome como está na lista: *aceitar ${r.id} Nome Sobrenome*`,
        ]
      : [`Se for um convidado, mande o nome como está na lista: *aceitar ${r.id} Nome Sobrenome*`]),
    `Se não for: *recusar ${r.id}*`,
  ].join('\n');
}

/** Resposta de public.bot_resolve_identity_request(). */
export type IdentityDecision =
  | { ok: true; status: 'accepted'; phone: string; claimed_name: string; guest_name: string; household: string | null; previous_phone: string | null }
  | { ok: true; status: 'rejected'; phone: string; claimed_name: string }
  | { ok: false; error: string; status?: 'accepted' | 'rejected'; guest_name?: string | null; other_name?: string; claimed_name?: string };

/** Erros de "aceitar N [nome]" em que vale mostrar os nomes parecidos da lista. */
const SUGGEST_ON_ERRORS: readonly string[] = ['need_guest_name', 'guest_not_found', 'guest_ambiguous', 'guest_need_full_name'];

/** Nome a comparar com a lista depois de um erro: o que o organizador mandou ou, sem ele, o que a pessoa disse. */
export function suggestionQuery(decision: IdentityDecision, name: string | null): string | null {
  if (decision.ok || !SUGGEST_ON_ERRORS.includes(decision.error)) return null;
  return name ?? decision.claimed_name ?? null;
}

/**
 * Resposta aos comandos "aceitar N" / "recusar N" (só depois que o banco aceitou).
 * Decisão tomada vai a todos os organizadores; erro, só a quem mandou.
 */
export function formatIdentityDecision(
  id: number,
  decision: IdentityDecision,
  adminPhone: string,
  name: string | null,
  suggestions: GuestSuggestion[] = [],
): string {
  if (decision.ok) {
    const by = `por ${formatPhone(adminPhone)}`;
    if (decision.status === 'rejected') {
      return `🚫 Pedido #${id} recusado (${by}). Avisei o número ${formatPhone(decision.phone)} para falar diretamente com a família.`;
    }
    const previous = decision.previous_phone
      ? ` O telefone antigo da lista (${formatPhone(decision.previous_phone)}) foi substituído.`
      : '';
    return (
      `✅ Pedido #${id} aceito (${by}): ${formatPhone(decision.phone)} agora é *${decision.guest_name}*` +
      `${decision.household ? ` (${decision.household})` : ''}.${previous} Já avisei a pessoa.`
    );
  }
  const error = identityErrorText(id, decision, name);
  return suggestions.length > 0 && SUGGEST_ON_ERRORS.includes(decision.error)
    ? [error, '', 'Nomes parecidos na lista:', ...suggestionLines(id, suggestions)].join('\n')
    : error;
}

function identityErrorText(id: number, decision: Extract<IdentityDecision, { ok: false }>, name: string | null): string {
  const askName = `*aceitar ${id} Nome Sobrenome*`;
  switch (decision.error) {
    case 'not_found':
      return `Não encontrei o pedido #${id}.`;
    case 'already_resolved':
      return decision.status === 'accepted'
        ? `O pedido #${id} já foi aceito${decision.guest_name ? ` (${decision.guest_name})` : ''}.`
        : `O pedido #${id} já foi recusado.`;
    case 'need_guest_name':
      return `Para aceitar o pedido #${id}, mande o nome do convidado como está na lista: ${askName}`;
    case 'guest_not_found':
      return `Não encontrei "${name}" na lista. Confira o nome e mande de novo: ${askName}`;
    case 'guest_ambiguous':
      return `Mais de um convidado parece com "${name}". Mande o nome completo como está na lista: ${askName}`;
    case 'guest_need_full_name':
      return `Mande nome e sobrenome do convidado como estão na lista: ${askName}`;
    case 'phone_in_use':
      return `Não aceitei o pedido #${id}: esse número já é de ${decision.other_name ?? 'outro convidado'} na lista.`;
    default:
      return `Não foi possível decidir o pedido #${id} (${decision.error}).`;
  }
}

/** Aviso aos organizadores quando a Aifos encaminha algo de um contato. */
export interface ContactCard {
  phone: string;
  display_name: string | null;
  guest_name: string | null;
  household: string | null;
  verified_by: 'phone' | 'name' | null;
}

export function formatForward(card: ContactCard, reason: string, phoneLabel: string): string {
  const who = card.guest_name
    ? `${card.guest_name}${card.household ? ` (${card.household})` : ''}`
    : `contato fora da lista${card.display_name ? ` ("${card.display_name}" no WhatsApp)` : ''}`;
  return ['🦉 *Aviso da Professora Aifos*', `De: ${who}`, `WhatsApp: ${phoneLabel}`, '', reason.trim()].join('\n');
}

const hourMinute = new Intl.DateTimeFormat('pt-BR', { timeZone: TIME_ZONE, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const gigabytes = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(bytes < 1024 ** 3 ? 2 : 1).replace('.', ',')} GB`;

/** Resposta ao comando "fotos": números do Profeta Diário e os últimos envios, com o N de cada um. */
export function formatProfetaSummary(s: ProfetaSummary): string {
  const window = s.janela === 'antes' ? 'envios abrem no dia da festa' : s.janela === 'aberta' ? 'recebendo fotos' : 'envios encerrados';
  const percent = s.cotaBytes > 0 ? Math.round((s.usadoBytes / s.cotaBytes) * 100) : 0;
  const lines = [
    `📸 *O Profeta Diário* (${window})`,
    `${s.fotos} foto${s.fotos === 1 ? '' : 's'} e ${s.videos} vídeo${s.videos === 1 ? '' : 's'} no jornal${s.retirados ? ` · ${s.retirados} retirado${s.retirados === 1 ? '' : 's'}` : ''}${s.naFila ? ` · ${s.naFila} na fila` : ''}${s.falhas ? ` · ${s.falhas} com falha` : ''}`,
    `Espaço: ${gigabytes(s.usadoBytes)} de ${gigabytes(s.cotaBytes)} (${percent}%)`,
  ];
  if (s.ultimos.length > 0) {
    lines.push('', '*Últimos envios*');
    for (const i of s.ultimos) {
      lines.push(
        `Nº ${i.n} · ${i.tipo === 'video' ? 'vídeo' : 'foto'} de ${i.autor ?? 'anônimo'} (${i.origem === 'whatsapp' ? 'WhatsApp' : 'site'}, ${hourMinute.format(new Date(i.em))})${i.retirado ? ' · retirada' : ''}`,
      );
    }
  }
  lines.push('', '_Para tirar uma do jornal: *retirar foto N*. Para voltar: *devolver foto N*._');
  return lines.join('\n');
}

/** Resposta a "retirar foto N" / "devolver foto N" (só depois que o serviço aceitou). */
export function formatProfetaRemoval(n: number, removed: boolean, result: ProfetaRemoval): string {
  if (!result.ok) {
    return result.error === 'nao_encontrada'
      ? `Não encontrei a foto Nº ${n} no Profeta. Mande *fotos* para ver os números.`
      : 'O Profeta Diário não respondeu agora. Tente de novo em instantes.';
  }
  const what = `${result.tipo === 'video' ? 'Vídeo' : 'Foto'} Nº ${n}${result.autor ? ` (de ${result.autor})` : ''}`;
  if (!result.mudou) return `${what} já estava ${removed ? 'fora do' : 'no'} jornal.`;
  const done = result.tipo === 'video' ? 'retirado' : 'retirada';
  return removed ? `${what} ${done} do Profeta Diário. Some da página na próxima atualização.` : `${what} de volta ao Profeta Diário.`;
}
