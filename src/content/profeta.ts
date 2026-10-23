/**
 * ============================================================================
 *  O PROFETA DIÁRIO: página das fotos e vídeos dos convidados (/profeta/)
 * ============================================================================
 *  Fora do menu do convite e do Google; protegida pela palavra mágica impressa nos cartões
 *  das mesas (a Professora Aifos também a passa a convidados da lista). A palavra NUNCA
 *  fica aqui: este arquivo é público. Ela mora só nos secrets (PROFETA_SENHA na VPS e
 *  nas Edge Functions). Os arquivos ficam na VPS, num disco de tamanho fixo.
 *  Plano e decisões: docs/arquitetura.md#o-profeta-diario.
 * ============================================================================
 */

export const profetaConfig = {
  /** Mesma origem do convite: o Traefik leva /api/profeta/* ao serviço da VPS. */
  api: '/api/profeta',
  /** Caminho público da página (o cartão das mesas e a Aifos usam o endereço completo). */
  path: '/profeta/',
  /** De quanto em quanto tempo a página procura fotos novas (só com a aba visível). */
  pollSeconds: 20,
  /** A foto é reduzida no celular até este lado maior antes de subir. */
  photoMaxPx: 2560,
  photoQuality: 0.86,
  /** Fotos menores que isto (e já JPEG) sobem como estão. */
  photoKeepBytes: 2.5 * 1024 * 1024,
  /** Limites do serviço (services/profeta/src/rules.ts): repetidos aqui para avisar antes do envio. */
  maxPhotoBytes: 20 * 1024 * 1024,
  maxVideoBytes: 80 * 1024 * 1024,
  maxVideoSeconds: 15,
  /** Tentativas por arquivo quando a internet da festa falha. */
  retries: 4,
};

export const profetaTexts = {
  pageTitle: 'O Profeta Diário · Edição especial',
  masthead: 'O Profeta Diário',
  kicker: 'Edição especial · Os 15 anos de Sofia',
  price: 'Grátis para convidados',
  headline: 'Hogwarts em festa: as fotografias da noite',
  standfirst:
    'Cada fotografia enviada pelos convidados ganha vida nestas páginas. Toque numa delas para ampliar.',

  gate: {
    title: 'Diga a palavra mágica',
    intro: 'Só convidados leem o Profeta. A palavra mágica está no cartão da sua mesa (ou peça à Professora Aifos).',
    label: 'Palavra mágica',
    submit: 'Abrir o jornal',
    wrong: 'Hmm, não é essa. Confira o cartão da mesa.',
    slow: 'Muitas tentativas. Respire fundo e tente de novo daqui a alguns minutos.',
    offline: 'A coruja não encontrou o caminho. Confira a internet e tente de novo.',
  },

  sender: {
    title: 'Mande sua fotografia ao Profeta',
    intro: 'Fotos e vídeos de até 15 segundos. Elas aparecem aqui para todos os convidados.',
    pick: 'Escolher fotos e vídeos',
    nameLabel: 'Quem tirou? (opcional)',
    namePlaceholder: 'Seu nome',
    captionLabel: 'Legenda (opcional)',
    captionPlaceholder: 'Ex.: A valsa!',
    whatsapp: 'Também dá para mandar direto para a Professora Aifos no WhatsApp.',
    before: 'O Profeta começa a circular no dia da festa. Volte aqui no dia 20/02 para mandar as suas fotografias!',
    closed: 'As rotativas pararam: o envio de fotografias foi encerrado. Obrigada por cada lembrança!',
    status: {
      waiting: 'Na fila',
      preparing: 'Preparando…',
      sending: 'Enviando',
      sent: 'Enviada! Aparece em instantes',
      retrying: 'Sem internet, tentando de novo…',
      failed: 'Não foi',
    },
    longVideo: 'Só os primeiros 15 segundos entram no jornal.',
  },

  errors: {
    formato_nao_aceito: 'Esse arquivo não é foto nem vídeo que o Profeta aceite.',
    grande_demais: 'Arquivo grande demais (vídeos: até 80 MB).',
    sem_espaco: 'O Profeta está sem páginas! Avise a família.',
    janela_antes: 'Os envios começam no dia da festa.',
    janela_fechada: 'Os envios foram encerrados.',
    devagar: 'Calma, bruxo! Muitos envios seguidos; tentando de novo.',
    sem_sessao: 'Sua sessão expirou: recarregue a página e diga a palavra mágica.',
    rede: 'A internet falhou.',
    desconhecido: 'Algo deu errado no envio.',
  },

  edition: {
    empty: 'As prensas estão aquecendo… Seja a primeira pessoa a mandar uma fotografia!',
    number: 'Nº',
    photoBy: 'Foto de',
    videoBy: 'Vídeo de',
    anonymous: 'um convidado',
    unavailable: 'A edição não chegou. Tentando de novo em instantes…',
    count: (n: number) => (n === 1 ? '1 fotografia' : `${n} fotografias`),
  },

  viewer: {
    close: 'Fechar',
    previous: 'Anterior',
    next: 'Próxima',
    of: 'de',
    sound: 'Ligar o som',
    mute: 'Desligar o som',
  },
};
