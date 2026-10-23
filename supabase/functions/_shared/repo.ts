/**
 * Acesso ao banco da Professora Aifos.
 *
 * Tudo passa pelas funções SQL do bot (supabase/migrations/*_bot_functions.sql),
 * que aplicam as regras de identidade, família, prazo e auditoria. Este módulo só
 * traduz chamadas e tipos: nenhuma regra de negócio mora aqui.
 *
 * O transporte é um `Rpc` genérico: em produção, `supabaseRpc(client)` (PostgREST);
 * nos testes e no simulador, o PGlite com as mesmas migrações
 * (scripts/lib/pglite-db.ts). Assim o mesmo código é exercitado contra o SQL real.
 */

/** Chama uma função SQL `public.<fn>` com argumentos nomeados e devolve o resultado. */
export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<unknown>;

/** O mínimo do cliente do supabase-js de que precisamos (evita importar o pacote aqui). */
export interface SupabaseRpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export function supabaseRpc(client: SupabaseRpcClient): Rpc {
  return async (fn, args) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };
}

export type RsvpStatus = 'pending' | 'attending' | 'declined';

/** guest = convidado; host = pai ou mãe da Sofia (organizadores); staff = equipe da festa (cerimonial). */
export type GuestRole = 'guest' | 'host' | 'staff';

export interface HouseholdMember {
  id: string;
  full_name: string;
  relationship: string | null;
  is_minor: boolean;
  is_you: boolean;
  rsvp_status: RsvpStatus;
  can_answer: boolean;
  /** Recado desta pessoa para a Sofia (null: ainda não tem). */
  message?: MemberMessage | null;
}

/**
 * Recado de um membro. O texto só vem para quem pode trocá-lo: o dono ou quem
 * o escreveu (enquanto o dono não o reescrever).
 */
export type MemberMessage =
  | {
      can_change: true;
      written_by_you: boolean;
      written_by_owner: boolean;
      body: string;
      signature: string | null;
      updated_at: string;
    }
  | { can_change: false; written_by_you: false; written_by_owner: boolean };

export type HouseholdStatus =
  | { identified: false; rsvp_open: boolean; deadline: string | null }
  | {
      identified: true;
      role: GuestRole;
      verified_by: 'phone' | 'name';
      rsvp_open: boolean;
      deadline: string | null;
      actor_id: string;
      /** Só para quem foi identificado pelo telefone. */
      household: string | null;
      members: HouseholdMember[];
    };

export type FindGuestResult =
  | { status: 'found'; guest: { id: string; full_name: string; has_phone: boolean } }
  | { status: 'ambiguous' | 'not_found' | 'need_full_name' };

export type RuleResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; guest_id?: string };

/** Pedido de identidade aberto para os organizadores decidirem ("aceitar N" / "recusar N"). */
export interface IdentityRequest {
  id: number;
  /** Número que escreveu (só dígitos). */
  phone: string;
  claimed_name: string;
  display_name: string | null;
  /** Convidado sugerido pela busca (tem outro telefone na lista); nulo se o nome não foi encontrado. */
  guest_name: string | null;
  household: string | null;
  guest_phone: string | null;
}

export type IdentityRequestResult =
  | ({ ok: true; created: true } & IdentityRequest)
  /** Já havia um pedido pendente deste número (os organizadores já foram avisados). */
  | { ok: true; created: false; id: number }
  | { ok: false; error: string };

/** Último pedido do número, para o contexto do turno. */
export interface IdentityRequestStatus {
  id: number;
  status: 'pending' | 'accepted' | 'rejected';
  claimed_name: string;
  created_at: string;
  resolved_at: string | null;
}

export interface RsvpChange {
  guest_id: string;
  full_name: string;
  previous_status: RsvpStatus;
  rsvp_status: RsvpStatus;
  changed: boolean;
}

/** Mensagem do histórico como gravada (o `content` é o mesmo enviado à API). */
export interface StoredMessage {
  role: 'user' | 'assistant' | 'system';
  content: unknown;
}

export interface Memory {
  contact: {
    display_name: string | null;
    preferred_name: string | null;
    first_seen_at: string;
    is_first_conversation: boolean;
  } | null;
  session: {
    id: string;
    started_at: string;
    last_message_at: string;
    turns: number;
    messages: StoredMessage[];
  } | null;
  summaries: { started_at: string; summary: string }[];
  notes: string[];
}

export type TurnAllowance = { allowed: true } | { allowed: false; reason: 'unknown_contact' | 'phone_limit' | 'global_limit' };

export interface GuestRepository {
  householdStatus(phone: string): Promise<HouseholdStatus>;
  findGuestByName(name: string): Promise<FindGuestResult>;
  linkContact(phone: string, guestId: string): Promise<RuleResult<{ guest_id: string; full_name: string }>>;
  /** Abre um pedido de identidade (um pendente por número; o banco limita). */
  requestIdentity(phone: string, claimedName: string, guestId: string | null): Promise<IdentityRequestResult>;
  identityRequestStatus(phone: string): Promise<IdentityRequestStatus | null>;
  setRsvp(
    phone: string,
    targets: string[],
    status: 'attending' | 'declined',
    waMessageId: string | null,
  ): Promise<RuleResult<{ results: RsvpChange[] }>>;
  addNote(phone: string, note: string): Promise<RuleResult>;
  setPreferredName(phone: string, name: string): Promise<RuleResult>;
  /**
   * Guarda (ou troca) um recado para a Sofia: do remetente ou, se ele responde
   * pela família, de outro membro (`forGuestId`). O banco decide quem pode.
   */
  saveGuestMessage(
    phone: string,
    message: {
      body: string;
      signature: string | null;
      source: 'text' | 'audio';
      waMessageId: string | null;
      forGuestId?: string | null;
    },
  ): Promise<RuleResult<{ replaced: boolean; full_name: string }>>;
  consumeTurn(phone: string): Promise<TurnAllowance>;
  loadMemory(phone: string, summaries?: number): Promise<Memory>;
  openSession(phone: string): Promise<string>;
  appendMessages(sessionId: string, messages: StoredMessage[], newTurn: boolean): Promise<void>;
  closeSession(sessionId: string, summary: string | null): Promise<void>;
  /** Telefones com conversa parada esperando o convidado (retomada). */
  followUpCandidates(minIdleMinutes: number, maxIdleMinutes: number, limit?: number): Promise<string[]>;
  markFollowedUp(sessionId: string): Promise<void>;
}

export function createRepository(rpc: Rpc): GuestRepository {
  const call = <T>(fn: string, args: Record<string, unknown>) => rpc(fn, args) as Promise<T>;
  return {
    householdStatus: (phone) => call('bot_household_status', { p_phone: phone }),
    findGuestByName: (name) => call('bot_find_guest_by_name', { p_name: name }),
    linkContact: (phone, guestId) => call('bot_link_contact', { p_phone: phone, p_guest_id: guestId }),
    requestIdentity: (phone, claimedName, guestId) =>
      call('bot_request_identity', { p_phone: phone, p_claimed_name: claimedName, p_guest_id: guestId }),
    identityRequestStatus: (phone) => call('bot_identity_request_status', { p_phone: phone }),
    setRsvp: (phone, targets, status, waMessageId) =>
      call('bot_set_rsvp', { p_phone: phone, p_targets: targets, p_status: status, p_wa_message_id: waMessageId }),
    addNote: (phone, note) => call('bot_add_note', { p_phone: phone, p_note: note }),
    setPreferredName: (phone, name) => call('bot_set_preferred_name', { p_phone: phone, p_name: name }),
    saveGuestMessage: (phone, m) =>
      call('bot_save_guest_message', {
        p_phone: phone,
        p_body: m.body,
        p_signature: m.signature,
        p_source: m.source,
        p_wa_message_id: m.waMessageId,
        p_for_guest_id: m.forGuestId ?? null,
      }),
    consumeTurn: (phone) => call('bot_consume_turn', { p_phone: phone }),
    loadMemory: (phone, summaries = 3) => call('bot_load_memory', { p_phone: phone, p_summaries: summaries }),
    openSession: (phone) => call('bot_open_session', { p_phone: phone }),
    appendMessages: async (sessionId, messages, newTurn) => {
      await rpc('bot_append_messages', { p_session_id: sessionId, p_messages: messages, p_new_turn: newTurn });
    },
    closeSession: async (sessionId, summary) => {
      await rpc('bot_close_session', { p_session_id: sessionId, p_summary: summary ?? '' });
    },
    followUpCandidates: (minIdleMinutes, maxIdleMinutes, limit = 20) =>
      call('bot_followup_candidates', {
        p_min_idle_minutes: minIdleMinutes,
        p_max_idle_minutes: maxIdleMinutes,
        p_limit: limit,
      }),
    markFollowedUp: async (sessionId) => {
      await rpc('bot_mark_followed_up', { p_session_id: sessionId });
    },
  };
}
