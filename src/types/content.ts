/** Modelos de dados do conteúdo editável do convite. */

export interface EventInfo {
  /** Nome completo da aniversariante. */
  celebrant: string;
  /** Nome usado nos destaques tipográficos. */
  celebrantFirstName: string;
  /** Data no formato AAAA-MM-DD. */
  date: string;
  /** Horário de início no formato HH:mm (horário local do evento). `null` enquanto não for definido. */
  time: string | null;
  /** Deslocamento UTC do local do evento, ex.: "-03:00" para o horário de Brasília. */
  utcOffset: string;
  /** Descrição legível do fuso, exibida junto à contagem regressiva. */
  timezoneLabel: string;
  /** Duração estimada da festa, usada no evento de calendário. */
  durationHours: number;
  venue: string;
  /** Endereço completo. `null` até ser fornecido pela família. */
  address: string | null;
  /** Link direto de mapa (Google Maps, Waze…). Tem prioridade sobre o endereço. */
  mapUrl: string | null;
  /** Traje sugerido. Exibido apenas quando preenchido. */
  dressCode: string | null;
}

export interface MessageWallConfig {
  /** Endereço público (sem chave) da função site-messages; `null` = só o convite para deixar recado. */
  endpoint: string | null;
}

export interface RsvpConfig {
  /** Confirmações abertas. Deve refletir `rsvp_settings.accepting_responses` no banco. */
  enabled: boolean;
  /** Se convidados podem levar acompanhantes (a Professora Aifos informa isso aos convidados). */
  allowCompanions: boolean;
  maxCompanions: number;
  /** Data limite (AAAA-MM-DD) exibida aos convidados. Deve refletir `rsvp_settings.deadline`. `null` para não exibir. */
  deadline: string | null;
  /**
   * WhatsApp da Professora Aifos: só dígitos, com DDI e DDD (ex.: '5511999999999').
   * `null` mostra o aviso "em breve" no lugar do botão.
   */
  whatsappNumber: string | null;
}

export type PixKeyType = 'cpf' | 'cnpj' | 'email' | 'phone' | 'random';

export interface PixConfig {
  enabled: boolean;
  /** Chave Pix fornecida pela família. `null` até ser configurada. */
  key: string | null;
  keyType: PixKeyType | null;
  /** Nome do recebedor exatamente como cadastrado no banco. */
  recipientName: string | null;
  /** Cidade do recebedor (exigida pelo padrão do QR Code Pix). */
  city: string | null;
  /**
   * Caminho para uma imagem de QR Code exportada pelo app do banco (ex.: "/pix/qrcode.png").
   * Quando preenchido, é usada no lugar do QR Code gerado automaticamente.
   */
  qrCodeImage: string | null;
}

/** Ícones disponíveis para os presentes (desenhos do lucide-react, no tom do pergaminho). */
export type GiftIcon =
  | 'gift'
  | 'wand'
  | 'book'
  | 'plane'
  | 'camera'
  | 'music'
  | 'gem'
  | 'shirt'
  | 'sparkles'
  | 'crown'
  | 'feather'
  | 'cake'
  | 'heart'
  | 'star'
  | 'watch';

interface GiftBase {
  /** Identificador estável: letras minúsculas, números e hífen (vai para o banco). */
  id: string;
  name: string;
  description?: string | null;
  icon?: GiftIcon | null;
  /**
   * Arquivo da foto em presentes-originais/ (ex.: 'fone.png'). `npm run gifts:images` gera
   * src/assets/presentes/<id>.webp; sem o arquivo gerado, o cartão mostra o ícone.
   */
  image?: string | null;
}

/** Cota: presente simbólico com valor fixo, pago pelo Asaas. Pode ser dado por várias pessoas. */
export interface QuotaGift extends GiftBase {
  kind: 'quota';
  /** Quanto a família recebe, em reais (o site soma os custos do Asaas ao preço exibido). */
  amount: number;
}

/** Vaquinha: cada convidado contribui com o valor que quiser, até a meta. */
export interface FundGift extends GiftBase {
  kind: 'fund';
  /** Meta em reais. */
  goal: number;
}

/** Sugestão livre: sem pagamento pelo site (o convidado compra onde preferir). */
export interface FreeGift extends GiftBase {
  kind: 'free';
  /** Link opcional de referência (só https). */
  url?: string | null;
  storeName?: string | null;
}

export type Gift = QuotaGift | FundGift | FreeGift;

/** Uma faixa de parcelamento do cartão no Asaas: até `upTo` parcelas, `percent`% sobre o total. */
export interface CardFeeBracket {
  upTo: number;
  percent: number;
}

export interface GiftsConfig {
  /** Função pública gift-checkout (cria o pagamento no Asaas). `null` = botão "Presentear" oculto. */
  checkoutEndpoint: string | null;
  /** Função pública site-gifts (progresso das vaquinhas). `null` = só a meta. */
  progressEndpoint: string | null;
  /** Parcelas máximas no cartão oferecidas pelo Asaas. */
  maxInstallments: number;
  /** Custos do Asaas, em reais e %, embutidos no preço exibido (a taxa fica com o convidado). */
  fees: {
    pixFixed: number;
    cardFixed: number;
    card: CardFeeBracket[];
  };
  /** Contribuição mínima e máxima na vaquinha, em reais. */
  fundMin: number;
  fundMax: number;
}

export interface ImageSource {
  type: 'image/avif' | 'image/webp';
  srcSet: string;
}

export interface GalleryPhoto {
  id: string;
  /** Imagem padrão (fallback). */
  src: string;
  /** Formatos modernos com variações de largura — gerados por `npm run photos`. */
  sources?: ImageSource[];
  width: number;
  height: number;
  alt: string;
  /** object-position em telas largas, ex.: "50% 30%". */
  position?: string;
  /** object-position em telas verticais. */
  positionMobile?: string;
  /** Legenda curta (opcional). */
  caption?: string | null;
  /** Marca a imagem como espaço reservado provisório. */
  placeholder?: boolean;
}

export interface AudioConfig {
  /** Caminho do arquivo de áudio autorizado (ex.: "/audio/tema.mp3"). `null` oculta o controle. */
  src: string | null;
  title: string | null;
  volume: number;
  /**
   * Começar a tocar ao abrir o site. Navegadores só liberam som após uma
   * interação; se bloquearem, a música começa no primeiro toque/clique.
   */
  autoplay: boolean;
}
