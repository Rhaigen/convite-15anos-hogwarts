/**
 * ============================================================================
 *  CONFIGURAÇÕES FUNCIONAIS: confirmação de presença, Salão, lista de presentes, Pix e música
 * ============================================================================
 */
import type { AudioConfig, GiftsConfig, MessageWallConfig, PixConfig, RsvpConfig } from '../types/content.ts';

/**
 * Confirmação de presença, feita pela Professora Aifos no WhatsApp.
 * IMPORTANTE: o banco de dados aplica as regras pela tabela `rsvp_settings`
 * (veja supabase/migrations). Ao mudar `enabled` ou `deadline` aqui, atualize lá
 * também: o banco é a fonte de verdade e a Aifos só grava o que ele aceita.
 * Também é lido pelo build (vite.config.ts, conteúdo <noscript>): sem APIs de navegador.
 */
export const rsvpConfig: RsvpConfig = {
  enabled: true,
  // Definido em 2026-10-15: sem acompanhantes, a lista de convidados está fechada.
  allowCompanions: false,
  maxCompanions: 0,
  // Data limite para responder (família, 2026-10-19). No banco: rsvp_settings.deadline =
  // '2026-12-25 23:59:59-03' (o dia inteiro conta).
  deadline: '2026-12-25',
  // Número dedicado da Professora Aifos (instância da Evolution API).
  whatsappNumber: '5511999999999',
};

/**
 * O Salão Principal (Capítulo IX): as cartas dos convidados vêm, ao vivo, de uma função
 * pública só de leitura (Edge Function site-messages). É um ENDEREÇO, não uma chave: a
 * função só devolve recados aprovados pelos organizadores ("publicar N" no WhatsApp), e o
 * texto só a partir do dia da festa (o selo é aplicado no banco).
 * `null` = o capítulo mostra apenas o convite para deixar um recado. VITE_MESSAGES_URL sobrepõe.
 * Também lido pelo build (CSP em vite.config.ts): sem APIs de navegador.
 */
export const messageWallConfig: MessageWallConfig = {
  endpoint: 'https://qqcqloxtgpajcksvslvd.supabase.co/functions/v1/site-messages',
};

/**
 * Lista de presentes (pergaminho do Capítulo VIII), paga na página segura do Asaas.
 * Os endereços são das funções públicas do Supabase (não são chaves): gift-checkout cria o
 * pagamento conferindo o preço pela cópia da lista que mora no servidor; site-gifts devolve o
 * progresso das vaquinhas. A chave do Asaas fica só nos secrets das funções.
 *
 * `fees`: tabela PADRÃO do Asaas (sem a promoção dos 3 primeiros meses), conferida em
 * 2026-10-18; confirme na conta (Menu do usuário > Taxas). O preço exibido cobre a forma de
 * pagamento mais cara permitida, então a família recebe pelo menos o valor da lista.
 * Mudou algo aqui: `npm run agent:facts` e republicar gift-checkout e site-gifts.
 * Também lido pelo build (CSP em vite.config.ts): sem APIs de navegador.
 */
export const giftsConfig: GiftsConfig = {
  checkoutEndpoint: 'https://qqcqloxtgpajcksvslvd.supabase.co/functions/v1/gift-checkout',
  progressEndpoint: 'https://qqcqloxtgpajcksvslvd.supabase.co/functions/v1/site-gifts',
  maxInstallments: 6,
  fees: {
    pixFixed: 1.99,
    cardFixed: 0.49,
    card: [
      { upTo: 1, percent: 2.99 },
      { upTo: 6, percent: 3.49 },
      { upTo: 12, percent: 3.99 },
      { upTo: 21, percent: 4.29 },
    ],
  },
  fundMin: 20,
  fundMax: 5000,
};

/**
 * Pix direto da família (dentro do pergaminho, para "qualquer quantia", sem custos).
 * O QR Code só é exibido quando a chave, o nome do recebedor
 * e a cidade estiverem preenchidos (ou quando `qrCodeImage` apontar para o
 * QR Code exportado pelo app do banco).
 * Recomendação de privacidade: prefira uma chave aleatória ou e-mail em vez de CPF.
 */
export const pixConfig: PixConfig = {
  enabled: true,
  key: null, // preenchida na publicação
  keyType: 'phone', // 'random' | 'email' | 'phone' | 'cpf' | 'cnpj'
  recipientName: null, // nome exatamente como cadastrado no banco
  city: null, // cidade do recebedor
  qrCodeImage: null,
};

/**
 * Música ambiente (opcional), salva em public/audio/. Com `autoplay`, começa ao
 * abrir o site (ou no primeiro toque, se o navegador bloquear som sem
 * interação); o botão de som no topo sempre permite pausar.
 */
export const audioConfig: AudioConfig = {
  src: '/audio/tema.mp3', // fora do Git (.gitignore): o arquivo precisa estar na máquina que faz o build
  title: 'Tema instrumental de Harry Potter',
  volume: 0.35,
  autoplay: true,
};
