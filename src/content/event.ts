/**
 * ============================================================================
 *  INFORMAÇÕES OFICIAIS DA CELEBRAÇÃO
 * ============================================================================
 *  Edite este arquivo para atualizar data, horário, local e endereço.
 *  Campos `null` ainda NÃO foram fornecidos pela família — o site exibe um
 *  aviso discreto ("a confirmar") e oculta os botões que dependem deles.
 *
 *  Este módulo também é lido pelo build (vite.config.ts) para gerar título,
 *  descrição de compartilhamento e o conteúdo <noscript>. Mantenha-o sem
 *  dependências de navegador.
 * ============================================================================
 */
import type { EventInfo } from '../types/content.ts';

export const event: EventInfo = {
  celebrant: 'Sofia',
  celebrantFirstName: 'Sofia',
  date: '2027-02-20',

  // Horário de início (HH:MM). Com null, a contagem regressiva usaria 00:00 do dia.
  time: '20:00',

  // Fuso confirmado pela família em 2026-10-19: horário de Brasília.
  utcOffset: '-03:00',
  timezoneLabel: 'horário de Brasília',

  durationHours: 5,

  venue: 'Cerimonial Casa de Pedra Slim',

  address: 'Av. Amazonas, 428 - Jockey de Itaparica, Vila Velha - ES, 29103-830',

  // Link do local no Google Maps (enviado pela família em 2026-10-22). Com null, o
  // botão e o ícone do mapa buscam "local + endereço" no Google Maps.
  mapUrl: 'https://maps.app.goo.gl/fZs1ZgVMJMzh3aPW6',

  // Traje sugerido (informado pela família em 2026-10-19).
  dressCode: 'Esporte Fino',
};
