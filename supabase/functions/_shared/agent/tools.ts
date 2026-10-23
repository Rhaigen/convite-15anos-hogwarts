/**
 * Ferramentas da Professora Aifos.
 *
 * A IA conversa e propõe; código e banco decidem. Cada ferramenta:
 *  - recebe só o que o modelo pode escolher (nunca o telefone nem "quem sou eu":
 *    a identidade vem do telefone do remetente, dentro do banco);
 *  - valida a entrada e autoriza no código antes de chamar o banco (que valida de
 *    novo e é a palavra final);
 *  - devolve um resultado curto em JSON, ou um erro explicado para o modelo
 *    contar à pessoa.
 * Efeitos colaterais visíveis (reação, aviso à família) são acumulados em
 * `TurnEffects` e executados por quem chamou o agente.
 *
 * Os fatos da festa (data, endereço, Pix…) não estão no prompt: só chegam ao
 * modelo por `ver_detalhes_da_festa`, que o código libera apenas para remetente
 * identificado na lista. Quem não foi convidado não recebe nada da festa.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { EVENT_FACTS } from '../eventFacts.ts';
import type { GuestRepository, IdentityRequest, RsvpChange, StoredMessage } from '../repo.ts';
import { ALLOWED_REACTIONS, REACTION_ATTENDING, REACTION_DECLINED } from './config.ts';
import { describeHousehold } from './context.ts';

export const TOOL_NAMES = {
  status: 'ver_situacao_da_familia',
  facts: 'ver_detalhes_da_festa',
  register: 'registrar_resposta',
  find: 'buscar_convidado',
  confirmIdentity: 'confirmar_identidade',
  remember: 'lembrar',
  preferredName: 'guardar_nome_preferido',
  react: 'reagir',
  forward: 'encaminhar_para_familia',
  message: 'guardar_recado',
  askFamily: 'pedir_confirmacao_da_familia',
  profeta: 'ver_profeta_diario',
} as const;

const objectSchema = (properties: Record<string, unknown>, required: string[]): Anthropic.Tool.InputSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

/** Ordem fixa: as ferramentas fazem parte do prefixo em cache. */
export const TOOLS: Anthropic.Tool[] = [
  {
    name: TOOL_NAMES.status,
    description:
      'Consulta no banco a situação atual da família do remetente (quem já respondeu e por quem ele pode responder). Use depois de registrar respostas ou quando precisar conferir.',
    input_schema: objectSchema({}, []),
  },
  {
    name: TOOL_NAMES.facts,
    description:
      'Devolve os fatos oficiais da festa: data, horário, local, endereço, mapa, traje, acompanhantes, presentes, Pix, site e a mensagem da Sofia. Use sempre que precisar de qualquer um deles (nunca responda de memória). Só funciona para remetente identificado na lista de convidados.',
    input_schema: objectSchema({}, []),
  },
  {
    name: TOOL_NAMES.register,
    description:
      'Registra a resposta de uma ou mais pessoas da família do remetente: "sim" (vai à festa) ou "nao" (não vai). Use só depois de a pessoa confirmar quem vai e quem não vai. Os ids vêm do contexto do sistema.',
    strict: true,
    input_schema: objectSchema(
      {
        respostas: {
          type: 'array',
          description: 'Uma entrada por pessoa.',
          items: objectSchema(
            {
              convidado_id: { type: 'string', description: 'id da pessoa, como aparece no contexto do sistema.' },
              presenca: { type: 'string', enum: ['sim', 'nao'] },
            },
            ['convidado_id', 'presenca'],
          ),
        },
      },
      ['respostas'],
    ),
  },
  {
    name: TOOL_NAMES.find,
    description:
      'Procura na lista de convidados pelo nome completo (nome e sobrenome). Use só quando o remetente NÃO estiver identificado no contexto.',
    strict: true,
    input_schema: objectSchema({ nome_completo: { type: 'string' } }, ['nome_completo']),
  },
  {
    name: TOOL_NAMES.confirmIdentity,
    description:
      'Vincula este telefone ao convidado encontrado por buscar_convidado, depois que a pessoa confirmou que é ela mesma.',
    strict: true,
    input_schema: objectSchema({ convidado_id: { type: 'string' } }, ['convidado_id']),
  },
  {
    name: TOOL_NAMES.remember,
    description:
      'Guarda uma anotação curta e duradoura sobre o remetente para as próximas conversas (até 200 caracteres).',
    strict: true,
    input_schema: objectSchema({ nota: { type: 'string' } }, ['nota']),
  },
  {
    name: TOOL_NAMES.preferredName,
    description: 'Guarda como o remetente prefere ser chamado (até 60 caracteres).',
    strict: true,
    input_schema: objectSchema({ nome: { type: 'string' } }, ['nome']),
  },
  {
    name: TOOL_NAMES.react,
    description:
      'Reage com um emoji à última mensagem do convidado, num momento especial. Não use para confirmações e recusas: o sistema já reage.',
    strict: true,
    input_schema: objectSchema({ emoji: { type: 'string', enum: [...ALLOWED_REACTIONS] } }, ['emoji']),
  },
  {
    name: TOOL_NAMES.forward,
    description:
      'Avisa a família (organizadores) sobre uma dúvida que você não sabe responder, um pedido que só ela resolve ou um problema. Escreva o motivo com o nome da pessoa e o pedido.',
    strict: true,
    input_schema: objectSchema({ motivo: { type: 'string' } }, ['motivo']),
  },
  {
    name: TOOL_NAMES.message,
    description:
      'Guarda um recado para a Sofia (até 1000 caracteres), que a família entrega à aniversariante. Use só depois de a pessoa aprovar o texto. Um recado por pessoa da família: o recado fica na vaga de quem você indicar em para_convidado_id (o próprio remetente ou, se ele pode responder pela família, outro membro). Guardar de novo na mesma vaga substitui o anterior.',
    strict: true,
    input_schema: objectSchema(
      {
        texto: { type: 'string', description: 'O recado, com as palavras da pessoa.' },
        assinatura: {
          type: 'string',
          description:
            'Como assinar (por exemplo "Pedro", "Tio Carlos e Marta" ou "Família Souza"); vazio para usar o nome de quem é a vaga.',
        },
        veio_de_audio: { type: 'boolean', description: 'true se o recado foi ditado em áudio.' },
        para_convidado_id: {
          type: 'string',
          description: 'id (do contexto do sistema) da pessoa em cuja vaga o recado fica; vazio = o próprio remetente.',
        },
      },
      ['texto', 'assinatura', 'veio_de_audio', 'para_convidado_id'],
    ),
  },
  {
    name: TOOL_NAMES.askFamily,
    description:
      'Pede aos organizadores que confirmem quem é o remetente, quando buscar_convidado não encontrou o nome depois de duas tentativas e a pessoa afirma que foi convidada. Não use para quem diz que não recebeu o convite. Os organizadores decidem pelo WhatsApp e o sistema avisa a pessoa.',
    strict: true,
    input_schema: objectSchema(
      { nome_informado: { type: 'string', description: 'O nome completo que a pessoa disse ter.' } },
      ['nome_informado'],
    ),
  },
  {
    name: TOOL_NAMES.profeta,
    description:
      'Devolve o endereço e a palavra mágica d\'O Profeta Diário, a página onde os convidados veem e mandam fotos e vídeos da festa, e como ele funciona. Use quando pedirem o link, a senha ou como mandar fotos. Só funciona para remetente identificado na lista.',
    input_schema: objectSchema({}, []),
  },
];

export interface TurnEffects {
  /** Reação disparada pelo código a partir do resultado do banco (tem prioridade). */
  systemReaction: string | null;
  /** Reação escolhida pelo agente (ferramenta reagir). */
  agentReaction: string | null;
  /** Avisos para a família. */
  forwards: string[];
  /** Pedidos de identidade abertos neste turno (aviso numerado aos organizadores). */
  identityRequests: IdentityRequest[];
  rsvpChanges: RsvpChange[];
}

export const emptyEffects = (): TurnEffects => ({
  systemReaction: null,
  agentReaction: null,
  forwards: [],
  identityRequests: [],
  rsvpChanges: [],
});

export interface ToolContext {
  repo: GuestRepository;
  phone: string;
  /** Mensagem do convidado que motivou o turno (auditoria e reações). */
  waMessageId: string | null;
  /** ids devolvidos por buscar_convidado nesta sessão (os únicos aceitos em confirmar_identidade). */
  foundGuestIds: Set<string>;
  effects: TurnEffects;
  /** Contadores por turno (contra abuso). */
  calls: Map<string, number>;
  /** O Profeta Diário (secrets PROFETA_URL e PROFETA_SENHA); null = ainda não está no ar. */
  profeta?: ProfetaAccess | null;
}

export interface ProfetaAccess {
  url: string;
  password: string;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

const MAX_CALLS_PER_TURN: Partial<Record<string, number>> = {
  [TOOL_NAMES.facts]: 2,
  [TOOL_NAMES.find]: 3,
  [TOOL_NAMES.forward]: 2,
  [TOOL_NAMES.remember]: 5,
  [TOOL_NAMES.message]: 2,
  [TOOL_NAMES.askFamily]: 1,
  [TOOL_NAMES.profeta]: 2,
};

const ERRORS: Record<string, string> = {
  not_identified: 'O remetente não está identificado. Peça o nome completo e use buscar_convidado.',
  not_a_guest: 'Pais da Sofia e equipe da festa não são convidados: não há presença a registrar.',
  signature_required: 'Recado de pai, mãe ou equipe vai assinado: pergunte como a pessoa se chama e use o nome na assinatura.',
  rsvp_closed: 'As confirmações estão encerradas. Oriente a pessoa a falar com a família.',
  not_in_household: 'Essa pessoa não é da família do remetente.',
  not_allowed: 'O remetente não pode responder por essa pessoa.',
  no_targets: 'Nenhuma pessoa informada.',
  too_many_targets: 'Pessoas demais num pedido só.',
  already_identified: 'O remetente já está identificado pelo telefone; não precisa vincular.',
  has_other_phone: 'Essa pessoa tem outro telefone cadastrado: peça que escreva de lá ou fale com a família.',
  linked_to_other_contact: 'Essa pessoa já está vinculada a outro número. Oriente a falar com a família.',
  not_found: 'Convidado não encontrado.',
  invalid_note: 'Anotação vazia ou longa demais (máximo 200 caracteres).',
  too_many_notes: 'Limite de anotações desta pessoa atingido.',
  invalid_name: 'Nome vazio ou longo demais (máximo 60 caracteres).',
  invalid_message: 'Recado vazio ou longo demais (máximo 1000 caracteres): peça para a pessoa resumir.',
  invalid_signature: 'Assinatura longa demais (máximo 80 caracteres).',
  not_identified_message: 'Só convidados da lista deixam recado para a Sofia. Peça o nome completo e use buscar_convidado.',
  not_allowed_message:
    'O remetente não pode deixar recado por essa pessoa (só quem responde pela família, identificado pelo telefone). Ela pode deixar o dela falando com você do próprio número.',
  request_rejected:
    'A família já disse que não reconhece este número. Não peça de novo: oriente com gentileza a falar diretamente com quem a convidou.',
  request_too_many_requests:
    'Este número já fez pedidos demais. Oriente a pessoa a falar diretamente com quem a convidou.',
  request_invalid_name: 'Informe o nome completo que a pessoa disse ter (até 120 caracteres).',
  request_already_identified: 'O remetente já está identificado; não precisa pedir confirmação.',
  message_owned:
    'Essa pessoa já tem um recado que foi escrito por outra pessoa; só a dona do recado (ou quem o escreveu) pode trocá-lo. Não mostre nem comente o texto.',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ok = (data: object): ToolOutcome => ({ content: JSON.stringify({ ok: true, ...data }), isError: false });
const fail = (message: string): ToolOutcome => ({ content: JSON.stringify({ ok: false, erro: message }), isError: true });
const ruleError = (code: string) => fail(ERRORS[code] ?? `Não foi possível (${code}).`);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function text(input: Record<string, unknown>, key: string, max: number): string | null {
  const v = input[key];
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t.length > 0 && t.length <= max ? t : null;
}

export async function executeTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const count = (ctx.calls.get(name) ?? 0) + 1;
  ctx.calls.set(name, count);
  const max = MAX_CALLS_PER_TURN[name];
  if (max !== undefined && count > max) return fail('Limite de uso desta ferramenta nesta mensagem.');

  const input = isRecord(rawInput) ? rawInput : {};
  switch (name) {
    case TOOL_NAMES.status:
      return familyStatus(ctx);
    case TOOL_NAMES.facts:
      return eventFacts(ctx);
    case TOOL_NAMES.profeta:
      return profetaInfo(ctx);
    case TOOL_NAMES.register:
      return registerAnswers(input, ctx);
    case TOOL_NAMES.find:
      return findGuest(input, ctx);
    case TOOL_NAMES.confirmIdentity:
      return confirmIdentity(input, ctx);
    case TOOL_NAMES.remember: {
      const note = text(input, 'nota', 200);
      if (!note) return ruleError('invalid_note');
      const r = await ctx.repo.addNote(ctx.phone, note);
      return r.ok ? ok({}) : ruleError(r.error);
    }
    case TOOL_NAMES.preferredName: {
      const nome = text(input, 'nome', 60);
      if (!nome) return ruleError('invalid_name');
      const r = await ctx.repo.setPreferredName(ctx.phone, nome);
      return r.ok ? ok({}) : ruleError(r.error);
    }
    case TOOL_NAMES.react: {
      const emoji = input.emoji;
      if (!(ALLOWED_REACTIONS as readonly unknown[]).includes(emoji)) return fail('Emoji não permitido.');
      ctx.effects.agentReaction = emoji as string;
      return ok({});
    }
    case TOOL_NAMES.message:
      return saveMessage(input, ctx);
    case TOOL_NAMES.askFamily: {
      const household = await ctx.repo.householdStatus(ctx.phone);
      if (household.identified) return ruleError('already_identified');
      const nome = text(input, 'nome_informado', 120);
      if (!nome) return ruleError('request_invalid_name');
      const r = await openIdentityRequest(ctx, nome, null);
      return r.ok ? ok(r.data) : ruleError(r.error);
    }
    case TOOL_NAMES.forward: {
      const motivo = text(input, 'motivo', 500);
      if (!motivo) return fail('Escreva o motivo (até 500 caracteres).');
      ctx.effects.forwards.push(motivo);
      return ok({ aviso: 'A família foi avisada.' });
    }
    default:
      return fail(`Ferramenta desconhecida: ${name}`);
  }
}

/**
 * Recado para a Sofia: quem escreve é sempre o remetente (o banco decide pelo
 * telefone); a vaga pode ser dele ou, se ele responde pela família, de outro membro.
 */
async function saveMessage(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  // Mantém as quebras de parágrafo; o resto do espaço vira um espaço só.
  const body =
    typeof input.texto === 'string'
      ? input.texto
          .split(/\n\s*\n/)
          .map((p) => p.replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .join('\n\n')
      : '';
  if (body.length === 0 || body.length > 1000) return ruleError('invalid_message');
  const rawSignature = typeof input.assinatura === 'string' ? input.assinatura.trim() : '';
  const signature = rawSignature ? text(input, 'assinatura', 80) : null;
  if (rawSignature && !signature) return ruleError('invalid_signature');

  const rawTarget = typeof input.para_convidado_id === 'string' ? input.para_convidado_id.trim() : '';
  if (rawTarget && !UUID.test(rawTarget)) return fail('para_convidado_id inválido: use um id do contexto do sistema ou vazio.');

  // Autorização no código, com a situação atual do banco (o banco confere de novo).
  const household = await ctx.repo.householdStatus(ctx.phone);
  if (!household.identified) return ruleError('not_identified_message');
  if (household.role !== 'guest' && !signature) return ruleError('signature_required');
  const target = rawTarget ? rawTarget.toLowerCase() : household.actor_id;
  const member = household.members.find((m) => m.id === target);
  if (!member) return ruleError('not_in_household');
  if (!member.can_answer) return fail(`${ERRORS.not_allowed_message} (${member.full_name})`);
  if (member.message && !member.message.can_change) return fail(`${ERRORS.message_owned} (${member.full_name})`);

  const r = await ctx.repo.saveGuestMessage(ctx.phone, {
    body,
    signature,
    source: input.veio_de_audio === true ? 'audio' : 'text',
    waMessageId: ctx.waMessageId,
    forGuestId: member.is_you ? null : member.id,
  });
  if (!r.ok) {
    if (r.error === 'not_identified') return ruleError('not_identified_message');
    if (r.error === 'not_allowed') return ruleError('not_allowed_message');
    return ruleError(r.error);
  }
  return ok({ guardado: true, na_vaga_de: r.full_name, substituiu_o_anterior: r.replaced });
}

async function familyStatus(ctx: ToolContext): Promise<ToolOutcome> {
  const status = await ctx.repo.householdStatus(ctx.phone);
  return ok({ situacao: describeHousehold(status).join('\n') });
}

/** Fatos da festa: só para quem está na lista (pelo telefone ou pelo nome confirmado). */
async function eventFacts(ctx: ToolContext): Promise<ToolOutcome> {
  const status = await ctx.repo.householdStatus(ctx.phone);
  if (!status.identified) {
    return fail(
      'Remetente fora da lista de convidados: os detalhes da festa são só para convidados. Não passe nenhuma informação da festa (data, horário, local, endereço, traje, presentes, Pix, site).',
    );
  }
  return ok({ fatos: EVENT_FACTS });
}

/**
 * O Profeta Diário: endereço e palavra mágica só para quem está na lista (como os fatos da festa).
 * A palavra vem de um secret, nunca do prompt nem do repositório.
 */
async function profetaInfo(ctx: ToolContext): Promise<ToolOutcome> {
  const status = await ctx.repo.householdStatus(ctx.phone);
  if (!status.identified) {
    return fail('Remetente fora da lista de convidados: O Profeta Diário é só para convidados. Não passe o endereço nem a palavra mágica.');
  }
  if (!ctx.profeta) return fail('O Profeta Diário ainda não está no ar. Diga que a família vai avisar quando ele começar a circular.');
  return ok({
    endereco: ctx.profeta.url,
    palavra_magica: ctx.profeta.password,
    como_funciona:
      'É o jornal das fotografias da festa: todos os convidados veem as fotos e os vídeos (até 15 segundos) que os outros mandam. Para mandar, é só abrir o endereço, dizer a palavra mágica e escolher as fotos, ou enviar as fotos e vídeos aqui mesmo nesta conversa, que vão direto para o jornal. Os envios abrem no dia da festa e ficam abertos por cerca de duas semanas. A palavra mágica também está impressa no cartão das mesas.',
  });
}

async function registerAnswers(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const items = Array.isArray(input.respostas) ? input.respostas : [];
  const answers = new Map<string, 'attending' | 'declined'>();
  for (const item of items) {
    if (!isRecord(item) || typeof item.convidado_id !== 'string' || !UUID.test(item.convidado_id)) {
      return fail('convidado_id inválido: use os ids do contexto do sistema.');
    }
    if (item.presenca !== 'sim' && item.presenca !== 'nao') return fail('presenca deve ser "sim" ou "nao".');
    const status = item.presenca === 'sim' ? 'attending' : 'declined';
    const id = item.convidado_id.toLowerCase();
    if (answers.has(id) && answers.get(id) !== status) return fail('A mesma pessoa aparece com respostas diferentes.');
    answers.set(id, status);
  }
  if (answers.size === 0) return ruleError('no_targets');

  // Autorização no código, com a situação atual do banco (o banco confere de novo).
  const household = await ctx.repo.householdStatus(ctx.phone);
  if (!household.identified) return ruleError('not_identified');
  if (household.role !== 'guest') return ruleError('not_a_guest');
  if (!household.rsvp_open) return ruleError('rsvp_closed');
  for (const id of answers.keys()) {
    const member = household.members.find((m) => m.id === id);
    if (!member) return ruleError('not_in_household');
    if (!member.can_answer) return fail(`${ERRORS.not_allowed} (${member.full_name})`);
  }

  const saved: RsvpChange[] = [];
  for (const status of ['attending', 'declined'] as const) {
    const targets = [...answers].filter(([, s]) => s === status).map(([id]) => id);
    if (targets.length === 0) continue;
    const r = await ctx.repo.setRsvp(ctx.phone, targets, status, ctx.waMessageId);
    if (!r.ok) {
      recordChanges(ctx, saved);
      return ruleError(r.error);
    }
    saved.push(...r.results);
  }
  recordChanges(ctx, saved);

  return ok({
    registrado: saved.map((c) => ({
      nome: c.full_name,
      presenca: c.rsvp_status === 'attending' ? 'sim' : 'nao',
      ja_estava_assim: !c.changed,
    })),
  });
}

/** Guarda as mudanças e escolhe a reação a partir do que o banco realmente gravou. */
function recordChanges(ctx: ToolContext, changes: RsvpChange[]): void {
  const changed = changes.filter((c) => c.changed);
  ctx.effects.rsvpChanges.push(...changed);
  if (changed.some((c) => c.rsvp_status === 'attending')) ctx.effects.systemReaction = REACTION_ATTENDING;
  else if (changed.some((c) => c.rsvp_status === 'declined')) ctx.effects.systemReaction = REACTION_DECLINED;
}

/** O que a Aifos diz enquanto os organizadores decidem. */
const REQUEST_GUIDANCE =
  'Não vincule e não passe nenhum detalhe da festa. Diga que pediu à família para confirmar que este número é da pessoa e que, assim que confirmarem, você avisa por aqui.';

/**
 * Abre um pedido de identidade para os organizadores (o banco limita: um
 * pendente por número, no máximo 3, nenhum depois de uma recusa). O aviso
 * numerado sai pelo orquestrador, só quando o pedido é novo.
 */
async function openIdentityRequest(
  ctx: ToolContext,
  claimedName: string,
  guestId: string | null,
): Promise<{ ok: true; data: object } | { ok: false; error: string }> {
  const r = await ctx.repo.requestIdentity(ctx.phone, claimedName, guestId);
  if (!r.ok) return { ok: false, error: `request_${r.error}` };
  if (r.created) {
    const { id, phone, claimed_name, display_name, guest_name, household, guest_phone } = r;
    ctx.effects.identityRequests.push({ id, phone, claimed_name, display_name, guest_name, household, guest_phone });
  }
  return {
    ok: true,
    data: { pedido_a_familia: r.created ? 'enviado' : 'ja_estava_aguardando', orientacao: REQUEST_GUIDANCE },
  };
}

async function findGuest(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const household = await ctx.repo.householdStatus(ctx.phone);
  if (household.identified) return ruleError('already_identified');
  const nome = text(input, 'nome_completo', 120);
  if (!nome) return fail('Informe o nome completo.');

  const r = await ctx.repo.findGuestByName(nome);
  switch (r.status) {
    case 'found':
      if (r.guest.has_phone) {
        // Número errado na lista ou celular novo: o código pede aos organizadores (sem depender do modelo).
        const request = await openIdentityRequest(ctx, nome, r.guest.id);
        if (!request.ok) {
          return ok({ resultado: 'tem_outro_telefone', nome: r.guest.full_name, orientacao: ERRORS[request.error] ?? ERRORS.has_other_phone });
        }
        return ok({ resultado: 'tem_outro_telefone', nome: r.guest.full_name, ...request.data });
      }
      ctx.foundGuestIds.add(r.guest.id);
      return ok({
        resultado: 'encontrado',
        convidado_id: r.guest.id,
        nome: r.guest.full_name,
        orientacao: 'Pergunte se a pessoa é ela mesma antes de chamar confirmar_identidade.',
      });
    case 'ambiguous':
      // A busca não diz quantos nem quais: inventar ("achei dois Caio") revelaria a lista a quem não foi identificado.
      return ok({
        resultado: 'ambiguo',
        orientacao:
          'Peça o nome completo exatamente como está no convite, com os nomes do meio. Não diga quantas pessoas nem que nomes parecidos existem na lista, e não diga que encontrou alguém.',
      });
    case 'need_full_name':
      return ok({ resultado: 'nome_incompleto', orientacao: 'Peça nome e sobrenome.' });
    default:
      return ok({ resultado: 'nao_encontrado' });
  }
}

async function confirmIdentity(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const id = typeof input.convidado_id === 'string' ? input.convidado_id.toLowerCase() : '';
  if (!ctx.foundGuestIds.has(id)) {
    return fail('Use um convidado_id devolvido por buscar_convidado nesta conversa.');
  }
  const r = await ctx.repo.linkContact(ctx.phone, id);
  if (!r.ok) return ruleError(r.error);
  const household = await ctx.repo.householdStatus(ctx.phone);
  return ok({ vinculado: r.full_name, situacao: describeHousehold(household).join('\n') });
}

/** ids encontrados por buscar_convidado em mensagens já gravadas da sessão. */
export function collectFoundGuestIds(history: StoredMessage[]): Set<string> {
  const findCalls = new Set<string>();
  const ids = new Set<string>();
  for (const m of history) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content as unknown[]) {
      if (!isRecord(block)) continue;
      if (block.type === 'tool_use' && block.name === TOOL_NAMES.find && typeof block.id === 'string') {
        findCalls.add(block.id);
      } else if (block.type === 'tool_result' && findCalls.has(block.tool_use_id as string)) {
        try {
          const result = JSON.parse(String(block.content)) as Record<string, unknown>;
          if (result.resultado === 'encontrado' && typeof result.convidado_id === 'string') ids.add(result.convidado_id);
        } catch {
          // resultado que não é JSON: ignora
        }
      }
    }
  }
  return ids;
}
