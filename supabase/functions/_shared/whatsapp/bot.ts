/**
 * Orquestrador do WhatsApp: código, não IA. Liga a fila de mensagens (wa_inbox),
 * o agente e a Evolution API.
 *
 *   processContact(telefone)                 ← webhook (em segundo plano) e varredura
 *     trava do contato (lease) ─► janela de silêncio (quem escreve em partes recebe uma resposta só)
 *     ─► fila pendente ─► "relatório", "recados", "presentes", "fotos", "retirar/devolver foto N",
 *        "publicar/retirar N" e "aceitar/recusar N" do organizador (sem IA); da equipe, só os das fotos
 *     ─► fotos e vídeos de convidado identificado → O Profeta Diário (sem IA, ver profeta.ts)
 *     ─► áudios transcritos ─► agent.handleTurn ─► fila baixada
 *     ─► lida ✓✓, reação, respostas com "digitando…", avisos aos organizadores
 *     ─► solta a trava e confere se chegou mais coisa enquanto isso
 *
 *   tick()          ← cron a cada 15 min: mensagens esquecidas e retomadas
 *   dailyReport()   ← cron diário: relatório aos organizadores
 *
 * Uma única execução por telefone de cada vez (bot_claim_contact). Quem não
 * consegue a trava sai: a execução que a tem confere a fila de novo ao soltar.
 */
import type { Agent, InboundMessage, Logger, TurnResult } from '../agent/index.ts';
import { daysUntilEvent } from '../agent/context.ts';
import { FIXED_REPLIES, IDENTITY_REPLIES } from '../agent/prompt.ts';
import type { Rpc } from '../repo.ts';
import { isTransientSendError, typingDelayMs, type WhatsAppClient } from './evolution.ts';
import { formatPhone, samePhone } from './phone.ts';
import {
  formatApproval,
  formatForward,
  formatGiftReport,
  formatGuestMessages,
  formatIdentityDecision,
  formatIdentityRequest,
  formatProfetaRemoval,
  formatProfetaSummary,
  formatReport,
  suggestionQuery,
  type ApprovalResult,
  type ContactCard,
  type GiftReportEntry,
  type GuestMessageEntry,
  type GuestSuggestion,
  type IdentityDecision,
  type ReportData,
} from './report.ts';
import { isPhotosCommand, parsePhotoCommand, PROFETA_REPLIES, type ProfetaClient } from './profeta.ts';
import type { Transcriber } from './transcriber.ts';

export interface InboxRow {
  id: number;
  wa_message_id: string;
  remote_jid: string | null;
  kind: InboundMessage['kind'];
  body: string | null;
  audio_seconds: number | null;
  received_at: string;
}

export interface BotOptions {
  /**
   * Janela de silêncio: a Aifos só responde depois deste tempo sem mensagem nova
   * do contato, para responder de uma vez a quem escreve em partes...
   */
  quietMs: number;
  /** ...ou depois deste teto, se a pessoa não parar de escrever. */
  maxGatherMs: number;
  /** Duração da trava do contato (maior que o tempo máximo de uma execução). */
  leaseSeconds: number;
  /** Áudios mais longos não são transcritos (custo e abuso). */
  maxAudioSeconds: number;
  /** Rodadas por execução (mensagens que chegam durante o processamento). */
  maxRounds: number;
  /** Mensagem na fila há mais que isto, sem trava, foi esquecida (execução que caiu). */
  stalledAfterSeconds: number;
  /** Contatos por execução do tick (o tempo de uma Edge Function é limitado). */
  perTick: number;
  /** Esperas antes de cada nova tentativa de envio após falha passageira da Evolution. */
  sendRetryDelaysMs: number[];
}

// Teste real (2026-10-15): partes da mesma ideia chegaram com 3,5 s de intervalo;
// mensagens independentes, com 25 s ou mais. Na mesma noite a Evolution ficou
// entre 20 e 30 s reconectando ao WhatsApp ("Connection Closed").
export const DEFAULT_BOT_OPTIONS: BotOptions = {
  quietMs: 8_000,
  maxGatherMs: 30_000,
  leaseSeconds: 180,
  maxAudioSeconds: 120,
  maxRounds: 3,
  stalledAfterSeconds: 180,
  perTick: 5,
  sendRetryDelaysMs: [5_000, 15_000],
};

export interface BotDeps {
  rpc: Rpc;
  agent: Pick<Agent, 'handleTurn' | 'followUp' | 'followUpCandidates' | 'canFollowUpNow'>;
  whatsapp: WhatsAppClient;
  /** Sem transcrição configurada, o áudio vira "não pôde ser transcrito". */
  transcriber: Transcriber | null;
  adminPhones: string[];
  /** Equipe da festa (cerimonial): conversa sem confirmar presença, como os pais. */
  staffPhones?: string[];
  /** O Profeta Diário (fotos dos convidados na VPS); null = desligado. */
  profeta?: { client: ProfetaClient; pageUrl: string | null } | null;
  options?: Partial<BotOptions>;
  log?: Logger;
  sleep?: (ms: number) => Promise<void>;
  typingMs?: (text: string) => number;
  clock?: () => Date;
}

/** Final do telefone, para os logs (o número inteiro é dado pessoal). */
export const maskPhone = (phone: string) => `…${phone.slice(-4)}`;

const normalizeCommand = (text: string | null) =>
  (text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z/ ]/g, '')
    .trim();

/** "relatório", "Relatorio", "/relatório." → comando do organizador. */
export function isReportCommand(text: string | null): boolean {
  return /^\/?relatorio( completo)?$/.test(normalizeCommand(text));
}

/** "recados", "Recado", "/recados!" → recados para a Sofia (comando do organizador). */
export function isMessagesCommand(text: string | null): boolean {
  return /^\/?recados?$/.test(normalizeCommand(text));
}

/** "presentes", "Presente", "/presentes!" → quem deu cada presente (comando do organizador). */
export function isGiftsCommand(text: string | null): boolean {
  return /^\/?presentes?$/.test(normalizeCommand(text));
}

/** "publicar 7", "/Publicar #7", "retirar 7." → pendura ou tira a carta do Salão do site. */
export function parseWallCommand(text: string | null): { approve: boolean; id: number } | null {
  const normalized = (text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
  const match = /^\/?(publicar|retirar)\s*(?:o\s+)?(?:recado\s+)?(?:n[ºo°.]?\s*)?#?\s*(\d{1,9})\s*[.!]*$/.exec(normalized);
  return match ? { approve: match[1] === 'publicar', id: Number(match[2]) } : null;
}

/**
 * "aceitar 12", "Aceito o pedido #12.", "aceitar 12 Jefferson Rocha", "recusar 12" →
 * decisão do organizador sobre um pedido de identidade. Em "aceitar", o texto depois
 * do número é o nome do convidado como está na lista; em "recusar", é ignorado.
 */
export function parseIdentityCommand(text: string | null): { accept: boolean; id: number; name: string | null } | null {
  const match = /^\/?\s*([^\s\d#]+)\s+(?:o\s+)?(?:pedido\s+)?(?:n[ºo°.]?\s*)?#?\s*(\d{1,9})(?![\d])\s*(.*)$/isu.exec(
    (text ?? '').trim(),
  );
  if (!match) return null;
  const verb = match[1]!.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const accept = ['aceitar', 'aceito', 'aceita'].includes(verb)
    ? true
    : ['recusar', 'recuso', 'recusa'].includes(verb)
      ? false
      : null;
  if (accept === null) return null;
  const name = accept
    ? match[3]!
        .replace(/[.!]+$/, '')
        .replace(/^[,:\-–]?\s*(?:como\s+|[ée]\s+)?(?:[ao]\s+)?/i, '')
        .replace(/^["“']+|["”']+$/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    : '';
  if (name.length > 120) return null;
  return { accept, id: Number(match[2]), name: name || null };
}

type AdminCommand =
  | { kind: 'report' }
  | { kind: 'messages' }
  | { kind: 'gifts' }
  | { kind: 'photos' }
  | { kind: 'photo'; removed: boolean; n: number }
  | { kind: 'wall'; approve: boolean; id: number }
  | { kind: 'identity'; accept: boolean; id: number; name: string | null };

function adminCommand(text: string | null): AdminCommand | null {
  if (isReportCommand(text)) return { kind: 'report' };
  if (isMessagesCommand(text)) return { kind: 'messages' };
  if (isGiftsCommand(text)) return { kind: 'gifts' };
  if (isPhotosCommand(normalizeCommand(text))) return { kind: 'photos' };
  // "retirar foto N" antes de "retirar N" (que é das cartas do Salão).
  const photo = parsePhotoCommand(text);
  if (photo) return { kind: 'photo', ...photo };
  const wall = parseWallCommand(text);
  if (wall) return { kind: 'wall', ...wall };
  const identity = parseIdentityCommand(text);
  return identity ? { kind: 'identity', ...identity } : null;
}

export function createWhatsAppBot(deps: BotDeps) {
  const options: BotOptions = { ...DEFAULT_BOT_OPTIONS, ...deps.options };
  const log: Logger = deps.log ?? (() => {});
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const typingMs = deps.typingMs ?? typingDelayMs;
  const clock = deps.clock ?? (() => new Date());
  const { rpc, agent, whatsapp, transcriber } = deps;

  const isAdmin = (phone: string) => deps.adminPhones.some((admin) => samePhone(admin, phone));
  const isStaff = (phone: string) => (deps.staffPhones ?? []).some((staff) => samePhone(staff, phone));
  /** Pais (organizadores) e equipe não são convidados: o banco guarda o papel antes da conversa. */
  const specialRole = (phone: string) => (isAdmin(phone) ? 'host' : isStaff(phone) ? 'staff' : null);
  /** Os pais usam todos os comandos; a equipe (cerimonial) só modera O Profeta Diário. O resto vai para a Aifos. */
  const commandFor = (phone: string, row: InboxRow): AdminCommand | null => {
    if (row.kind !== 'text') return null;
    const command = adminCommand(row.body);
    if (!command) return null;
    if (isAdmin(phone)) return command;
    return isStaff(phone) && (command.kind === 'photos' || command.kind === 'photo') ? command : null;
  };

  const claim = async (phone: string) =>
    (await rpc('bot_claim_contact', { p_phone: phone, p_lease_seconds: options.leaseSeconds })) === true;
  const pending = async (phone: string) => ((await rpc('bot_inbox_pending', { p_phone: phone })) ?? []) as InboxRow[];

  async function release(phone: string): Promise<void> {
    try {
      await rpc('bot_release_contact', { p_phone: phone });
    } catch (error) {
      // A trava expira sozinha; a varredura do cron recupera o que ficar na fila.
      log('release_failed', { phone: maskPhone(phone), error: String(error) });
    }
  }

  /** Efeitos externos não podem derrubar o resto da entrega. */
  async function attempt(event: string, phone: string, action: () => Promise<unknown>): Promise<boolean> {
    try {
      await action();
      return true;
    } catch (error) {
      log(event, { phone: maskPhone(phone), error: String(error) });
      return false;
    }
  }

  /** Envia um texto; em falha passageira espera e tenta de novo. */
  async function send(phone: string, text: string, typing: number): Promise<void> {
    const delays = options.sendRetryDelaysMs;
    for (let retry = 0; ; retry++) {
      try {
        return await whatsapp.sendText(phone, text, typing);
      } catch (error) {
        if (retry >= delays.length || !isTransientSendError(error)) throw error;
        log('send_retry', { phone: maskPhone(phone), retry: retry + 1, error: String(error) });
        await sleep(delays[retry]!);
      }
    }
  }

  async function toInbound(row: InboxRow): Promise<InboundMessage> {
    const base = { waMessageId: row.wa_message_id, kind: row.kind };
    if (row.kind !== 'audio') return { ...base, text: row.body };
    if (row.audio_seconds !== null && row.audio_seconds > options.maxAudioSeconds) {
      return { ...base, text: null, audioTooLong: true };
    }
    if (!transcriber) return { ...base, text: null };
    try {
      const media = await whatsapp.downloadMedia(row.wa_message_id);
      const text = await transcriber.transcribe(media);
      log('audio_transcribed', { seconds: row.audio_seconds, chars: text.length });
      return { ...base, text: text || null };
    } catch (error) {
      log('transcription_failed', { error: String(error) });
      return { ...base, text: null };
    }
  }

  /** Nomes da lista parecidos com `name`; sem eles (ou em falha), o aviso sai do mesmo jeito. */
  async function suggestGuests(name: string | null): Promise<GuestSuggestion[]> {
    if (!name) return [];
    try {
      return (await rpc('bot_suggest_guest_names', { p_name: name })) as GuestSuggestion[];
    } catch (error) {
      log('suggest_failed', { error: String(error) });
      return [];
    }
  }

  async function sendToAdmins(messages: string[]): Promise<void> {
    for (const admin of deps.adminPhones) {
      for (const text of messages) {
        if (!(await attempt('admin_send_failed', admin, () => send(admin, text, 0)))) break;
      }
    }
  }

  /** Entrega o resultado de um turno: reação, respostas e avisos aos organizadores. */
  async function deliver(phone: string, result: TurnResult, rows: InboxRow[]): Promise<void> {
    if (result.reaction) {
      const { emoji, waMessageId } = result.reaction;
      const row = rows.find((r) => r.wa_message_id === waMessageId);
      if (row?.remote_jid) await attempt('reaction_failed', phone, () => whatsapp.sendReaction(row.remote_jid!, waMessageId, emoji));
    }
    // Parte que não saiu interrompe as seguintes: resposta pela metade fora de ordem confunde mais.
    let sent = 0;
    for (const reply of result.replies) {
      if (!(await attempt('send_failed', phone, () => send(phone, reply, typingMs(reply))))) break;
      sent++;
    }
    if (result.forwards.length > 0 && deps.adminPhones.length > 0) {
      const card = (await rpc('bot_contact_card', { p_phone: phone })) as ContactCard;
      await sendToAdmins(result.forwards.map((reason) => formatForward(card, reason, formatPhone(phone))));
    }
    if (result.identityRequests.length > 0) {
      if (deps.adminPhones.length === 0) log('identity_request_without_admins', { phone: maskPhone(phone) });
      const notices: string[] = [];
      for (const r of result.identityRequests) {
        notices.push(formatIdentityRequest(r, r.guest_name ? [] : await suggestGuests(r.claimed_name)));
      }
      await sendToAdmins(notices);
    }
    log('delivered', {
      phone: maskPhone(phone),
      outcome: result.outcome,
      replies: result.replies.length,
      sent,
      reaction: result.reaction?.emoji ?? null,
      forwards: result.forwards.length,
      identityRequests: result.identityRequests.length,
      rsvpChanges: result.rsvpChanges.filter((c) => c.changed).length,
    });
  }

  const loadReport = async () => (await rpc('bot_report', {})) as ReportData;

  /** "fotos" / "retirar foto N" / "devolver foto N": o serviço do Profeta decide; erro vira aviso, nunca sucesso falso. */
  async function photoCommand(command: Extract<AdminCommand, { kind: 'photos' | 'photo' }>): Promise<string> {
    if (!deps.profeta) return 'O Profeta Diário ainda não está ligado nas Edge Functions (secrets PROFETA_*).';
    if (command.kind === 'photo') {
      return formatProfetaRemoval(command.n, command.removed, await deps.profeta.client.setRemoved(command.n, command.removed));
    }
    try {
      return formatProfetaSummary(await deps.profeta.client.summary());
    } catch (error) {
      log('profeta_summary_failed', { error: String(error) });
      return 'O Profeta Diário não respondeu agora. Tente de novo em instantes.';
    }
  }

  /**
   * Fotos e vídeos de quem está na lista vão direto para O Profeta Diário (o serviço da VPS baixa
   * a mídia da Evolution): reação 📸 em cada um e uma resposta fixa por rodada, sem IA. Fora da
   * lista, a mensagem segue para a Aifos como sempre. Devolve o que sobrou para a conversa.
   */
  async function toProfeta(phone: string, rows: InboxRow[]): Promise<InboxRow[]> {
    const media = rows.filter((r) => r.kind === 'image' || r.kind === 'video');
    if (!deps.profeta || media.length === 0) return rows;
    const card = (await rpc('bot_contact_card', { p_phone: phone })) as ContactCard | null;
    if (!card?.guest_name) return rows;

    const { client, pageUrl } = deps.profeta;
    let sent = 0;
    let videos = 0;
    let failed = 0;
    let closedWindow: 'antes' | 'fechada' | null = null;
    for (const row of media) {
      const result = await client.sendFromWhatsApp({ waMessageId: row.wa_message_id, author: card.guest_name, caption: row.body });
      if (result.ok) {
        sent++;
        if (result.tipo === 'video') videos++;
        if (row.remote_jid) await attempt('reaction_failed', phone, () => whatsapp.sendReaction(row.remote_jid!, row.wa_message_id, '📸'));
      } else if (result.error === 'janela_antes' || result.error === 'janela_fechada') {
        closedWindow = result.error === 'janela_antes' ? 'antes' : 'fechada';
      } else {
        failed++;
        log('profeta_failed', { phone: maskPhone(phone), error: result.error });
      }
    }
    log('profeta_media', { phone: maskPhone(phone), sent, failed, window: closedWindow });

    const replies: string[] = [];
    if (sent > 0) replies.push(PROFETA_REPLIES.sent(sent, videos, pageUrl));
    if (failed > 0) replies.push(PROFETA_REPLIES.failed(pageUrl));
    if (closedWindow && sent === 0 && failed === 0) replies.push(closedWindow === 'antes' ? PROFETA_REPLIES.before : PROFETA_REPLIES.closed);
    for (const text of replies) {
      if (!(await attempt('send_failed', phone, () => send(phone, text, typingMs(text))))) break;
    }
    return rows.filter((r) => !media.includes(r));
  }

  /**
   * "aceitar N" / "recusar N": o banco decide e audita; a decisão vai a todos os
   * organizadores (o outro fica sabendo e não decide de novo) e uma mensagem fixa
   * (sem IA) vai à pessoa. Erro volta só para quem mandou.
   */
  async function decideIdentity(admin: string, command: Extract<AdminCommand, { kind: 'identity' }>): Promise<void> {
    log('admin_identity', { phone: maskPhone(admin), id: command.id, accept: command.accept });
    const decision = (await rpc('bot_resolve_identity_request', {
      p_id: command.id,
      p_accept: command.accept,
      p_admin_phone: admin,
      p_guest_name: command.name,
    })) as IdentityDecision;
    const suggestions = await suggestGuests(suggestionQuery(decision, command.name));
    const text = formatIdentityDecision(command.id, decision, admin, command.name, suggestions);
    if (!decision.ok) {
      await attempt('send_failed', admin, () => send(admin, text, 0));
      return;
    }
    const notice =
      decision.status === 'accepted'
        ? IDENTITY_REPLIES.accepted(decision.guest_name.split(' ')[0] ?? decision.guest_name)
        : IDENTITY_REPLIES.rejected;
    await attempt('send_failed', decision.phone, () => send(decision.phone, notice, typingMs(notice)));
    await sendToAdmins([text]);
  }

  /** Espera a pessoa terminar de escrever: fila sem novidade por `quietMs` (ou o teto). */
  async function gather(phone: string): Promise<InboxRow[]> {
    let rows = await pending(phone);
    let waited = 0;
    while (rows.length > 0 && waited < options.maxGatherMs && options.quietMs > 0) {
      const step = Math.min(options.quietMs, options.maxGatherMs - waited);
      await sleep(step);
      waited += step;
      const next = await pending(phone);
      const grew = next.length > rows.length;
      rows = next;
      if (!grew) break;
    }
    return rows;
  }

  /** Uma rodada com a trava na mão. Devolve false se a fila estava vazia. */
  async function processPending(phone: string): Promise<boolean> {
    const rows = await gather(phone);
    if (rows.length === 0) return false;
    const ids = rows.map((r) => r.id);

    // ✓✓ azul: a Aifos "leu" (por conversa; normalmente uma só).
    const byJid = new Map<string, string[]>();
    for (const r of rows) if (r.remote_jid) byJid.set(r.remote_jid, [...(byJid.get(r.remote_jid) ?? []), r.wa_message_id]);
    for (const [jid, messageIds] of byJid) await attempt('mark_read_failed', phone, () => whatsapp.markRead(jid, messageIds));

    const commands = rows.filter((r) => commandFor(phone, r));
    let conversation = rows.filter((r) => !commands.includes(r));

    // Cada comando responde uma vez por rodada, na ordem em que apareceu.
    const unique = new Map(commands.map((r) => commandFor(phone, r)!).map((c) => [JSON.stringify(c), c] as const));
    for (const command of unique.values()) {
      let messages: string[];
      if (command.kind === 'report') {
        log('admin_report', { phone: maskPhone(phone) });
        messages = formatReport(await loadReport(), 'on_demand');
      } else if (command.kind === 'messages') {
        log('admin_messages', { phone: maskPhone(phone) });
        messages = formatGuestMessages((await rpc('bot_guest_messages', {})) as GuestMessageEntry[]);
      } else if (command.kind === 'gifts') {
        log('admin_gifts', { phone: maskPhone(phone) });
        messages = formatGiftReport((await rpc('bot_gift_report', {})) as GiftReportEntry[]);
      } else if (command.kind === 'photos' || command.kind === 'photo') {
        log('admin_photos', { phone: maskPhone(phone), ...(command.kind === 'photo' ? { n: command.n, removed: command.removed } : {}) });
        messages = [await photoCommand(command)];
      } else if (command.kind === 'wall') {
        log('admin_wall', { phone: maskPhone(phone), id: command.id, approve: command.approve });
        const result = (await rpc('bot_set_message_approval', { p_id: command.id, p_approved: command.approve })) as ApprovalResult;
        messages = [formatApproval(command.id, command.approve, result)];
      } else {
        await decideIdentity(phone, command);
        continue;
      }
      for (const text of messages) {
        if (!(await attempt('send_failed', phone, () => send(phone, text, 0)))) break;
      }
    }

    const role = specialRole(phone);
    if (deps.profeta && conversation.some((r) => r.kind === 'image' || r.kind === 'video')) {
      try {
        // Pais e equipe também mandam fotos: o papel (e o nome) precisa estar no banco antes.
        if (role) await rpc('bot_ensure_special_contact', { p_phone: phone, p_role: role });
        conversation = await toProfeta(phone, conversation);
      } catch (error) {
        log('profeta_route_failed', { phone: maskPhone(phone), error: String(error) });
      }
    }

    if (conversation.length === 0) {
      await rpc('bot_inbox_done', { p_ids: ids });
      return true;
    }

    let result: TurnResult;
    try {
      if (role) await rpc('bot_ensure_special_contact', { p_phone: phone, p_role: role });
      const messages = await Promise.all(conversation.map(toInbound));
      result = await agent.handleTurn({ phone, messages });
    } catch (error) {
      // Falha do banco ou bug: baixa a fila (sem repetir em loop) e pede para reenviar.
      log('turn_failed', { phone: maskPhone(phone), error: String(error) });
      await attempt('inbox_done_failed', phone, () => rpc('bot_inbox_done', { p_ids: ids }));
      await attempt('send_failed', phone, () => send(phone, FIXED_REPLIES.error, typingMs(FIXED_REPLIES.error)));
      return true;
    }

    // O turno já está gravado no histórico: baixa a fila antes de enviar, para
    // uma queda durante o envio não gerar uma segunda resposta.
    await rpc('bot_inbox_done', { p_ids: ids });
    await deliver(phone, result, conversation);
    return true;
  }

  /** Responde tudo o que estiver na fila do contato (chamado pelo webhook). */
  async function processContact(phone: string): Promise<void> {
    for (let round = 0; round < options.maxRounds; round++) {
      if (!(await claim(phone))) return; // outra execução está cuidando
      let worked: boolean;
      try {
        worked = await processPending(phone);
      } finally {
        await release(phone);
      }
      // Soltou primeiro, conferiu depois: mensagem que chegou no meio não fica esquecida.
      if (!worked || (await pending(phone)).length === 0) return;
    }
  }

  /** Retoma a conversa parada de um contato (com a trava, como um turno). */
  async function followUpContact(phone: string): Promise<void> {
    if (!(await claim(phone))) return;
    try {
      const result = await agent.followUp(phone);
      if (result.replies.length > 0) await deliver(phone, result, []);
      else log('no_follow_up', { phone: maskPhone(phone), outcome: result.outcome });
    } finally {
      await release(phone);
    }
  }

  /** Cron a cada 15 min: mensagens esquecidas na fila e retomadas. */
  async function tick(): Promise<{ stalled: number; followUps: number }> {
    const stalled = ((await rpc('bot_inbox_stalled', {
      p_min_age_seconds: options.stalledAfterSeconds,
      p_limit: options.perTick,
    })) ?? []) as string[];
    for (const phone of stalled) {
      log('stalled_inbox', { phone: maskPhone(phone) });
      await attempt('stalled_failed', phone, () => processContact(phone));
    }

    if (!agent.canFollowUpNow()) return { stalled: stalled.length, followUps: 0 };
    const candidates = await agent.followUpCandidates(options.perTick);
    for (const phone of candidates) await attempt('follow_up_failed', phone, () => followUpContact(phone));
    return { stalled: stalled.length, followUps: candidates.length };
  }

  /** Cron diário: relatório aos organizadores (com a lista importada, até o dia da festa). */
  async function dailyReport(): Promise<boolean> {
    if (deps.adminPhones.length === 0 || daysUntilEvent(clock()) < 0) return false;
    const report = await loadReport();
    if (report.totals.guests === 0) return false;
    await sendToAdmins(formatReport(report, 'daily'));
    log('daily_report_sent', { admins: deps.adminPhones.length });
    return true;
  }

  return { processContact, tick, dailyReport, options };
}

export type WhatsAppBot = ReturnType<typeof createWhatsAppBot>;
