/**
 * Monta os fatos oficiais da festa para a Professora Aifos a partir de
 * src/content/ (a mesma fonte do site). O resultado vira o arquivo gerado
 * supabase/functions/_shared/eventFacts.ts, porque as Edge Functions não
 * importam arquivos de fora de supabase/functions.
 *
 * Regra do projeto: nada é inventado. Campo `null` vira "a família ainda vai
 * informar", e a Aifos é instruída a dizer exatamente isso.
 */
import { event } from '../../src/content/event.ts';
import { giftList } from '../../src/content/gifts.ts';
import { giftsConfig, pixConfig, rsvpConfig } from '../../src/content/settings.ts';
import { siteMeta } from '../../src/content/site.ts';
import { closing, gifts, guestMessage, house } from '../../src/content/texts.ts';
import { getMapUrl } from '../../src/lib/calendar.ts';
import { formatDateLong, formatTime, getEventStart } from '../../src/lib/date.ts';

const PENDING = 'a família ainda vai informar';

export function buildEventFacts(): string[] {
  const mapUrl = getMapUrl(event);
  const lines = [
    `- Aniversariante: ${event.celebrant}, que está completando 15 anos.`,
    `- Tema do convite: Harry Potter, casa Grifinória (lema: "${house.tagline}").`,
    `- Data: ${formatDateLong(event.date)}.`,
    event.time
      ? `- Início: ${formatTime(event.time)} (${event.timezoneLabel}). Duração prevista: cerca de ${event.durationHours} horas.`
      : `- Horário: ${PENDING}.`,
    `- Local: ${event.venue ?? PENDING}.`,
    `- Endereço: ${event.address ?? PENDING}.`,
    mapUrl ? `- Mapa: ${mapUrl}` : null,
    `- Traje: ${event.dressCode ?? PENDING}.`,
    rsvpConfig.allowCompanions
      ? `- Acompanhantes: permitidos, até ${rsvpConfig.maxCompanions} por convidado.`
      : '- Acompanhantes: a lista de convidados está fechada; não é possível incluir quem não recebeu o convite.',
    `- Presentes: "${gifts.intro}"`,
    giftList.length > 0
      ? `- Lista de presentes: fica no site do convite (Capítulo VIII, "${gifts.title}"), num pergaminho que abre pelo botão "${gifts.openButton}". Itens: ${giftList.map((g) => g.name).join('; ')}. Os presentes em dinheiro são pagos na página segura do Asaas, por Pix ou cartão${giftsConfig.maxInstallments > 1 ? ` em até ${giftsConfig.maxInstallments}x` : ''}, e quem quiser pode deixar uma mensagem junto (assinada ou em segredo), que vai para o Livro de Recados da Sofia.`
      : `- Lista de presentes: ${gifts.empty}`,
    giftList.length > 0 ? `- Presente já comprado ou repetido (você não vê o que foi pago): "${gifts.alreadyGiven}"` : null,
    pixConfig.enabled && pixConfig.key && pixConfig.recipientName
      ? `- Pix: chave ${pixConfig.key}, em nome de ${pixConfig.recipientName}. O QR Code está no site do convite.`
      : `- Pix: ${gifts.pixPending}`,
    siteMeta.url
      ? `- Site do convite: ${siteMeta.url.replace(/\/+$/, '')} (o convite completo: carta, detalhes da festa, mapa e presentes). Envie o link quando pedirem o convite ou o site.`
      : '- Site do convite: ainda não está no ar; a família vai divulgar o link em breve.',
    `- Mensagem da Sofia aos convidados: "${guestMessage.paragraphs.join(' ')}"`,
    `- Encerramento do convite: "${closing.message}"`,
  ];
  return lines.filter((l): l is string => l !== null);
}

/** Conteúdo do arquivo supabase/functions/_shared/eventFacts.ts. */
export function renderEventFactsModule(): string {
  const facts = buildEventFacts()
    .map((l) => `  ${JSON.stringify(l)},`)
    .join('\n');
  return `/**
 * Fatos oficiais da festa para a Professora Aifos.
 * GERADO por \`npm run agent:facts\` a partir de src/content/: não edite à mão.
 * tests/event-facts.test.ts falha se este arquivo ficar desatualizado.
 */

/** Início da festa (ISO 8601 com o fuso). */
export const EVENT_START = ${JSON.stringify(getEventStart(event).toISOString())};

export const EVENT_FACTS = [
${facts}
].join('\\n');
`;
}
