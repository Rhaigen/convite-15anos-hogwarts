/**
 * ============================================================================
 *  TEXTOS DO CONVITE (VERSÃO PROVISÓRIA)
 * ============================================================================
 *  Todos os textos exibidos no site estão aqui. A família pode substituí-los
 *  livremente: basta manter a estrutura (listas de parágrafos, títulos etc.).
 *  Datas e local vêm de `event.ts` para evitar informações divergentes.
 * ============================================================================
 */
import { event } from './event.ts';
import { formatDateMedium } from '../lib/date.ts';

const dateText = formatDateMedium(event.date);

/** Carta revelada ao abrir o envelope. */
export const letter = {
  envelopeHeading: 'Uma carta chegou para você',
  envelopeAddress: ['Você foi convidado', `Celebração dos 15 anos de ${event.celebrantFirstName}`],
  openHint: 'Toque na carta para romper o selo',
  /** Aviso abaixo da dica (só com música configurada em `audioConfig`). */
  soundHint: 'Ligue o som',
  paragraphs: [
    'Por meio desta carta, você está oficialmente convidada para uma celebração extraordinária.',
    `No dia ${dateText}, uma noite especial reunirá magia, memórias e pessoas queridas para celebrar os 15 anos de ${event.celebrant}.`,
    'Prepare-se para atravessar as portas de um universo encantado e fazer parte de uma história que ficará para sempre na memória.',
  ],
  closingLine: 'Sua presença faz parte desta magia.',
  signOff: 'Com carinho,',
  signature: event.celebrant,
  continueLabel: 'Atravessar o portal',
};

/** Capítulo I — transição entre a carta e o mundo mágico. */
export const passage = {
  kicker: 'Capítulo I',
  title: 'A Travessia',
  line: 'Toda grande história começa quando alguém aceita o convite.',
  /** Dica discreta no pé da parede, some assim que a rolagem começa. */
  scrollHint: 'Desça a tela',
};

/** Capítulo II — apresentação visual da aniversariante. */
export const house = {
  kicker: 'Capítulo II',
  title: 'A Casa da Coragem',
  surname: 'Grifinória',
  age: 'XV',
  tagline: 'Coragem no coração, magia no olhar.',
  virtues: ['Coragem', 'Lealdade', 'Ousadia'],
};

/** Capítulo III — galeria. */
export const gallery = {
  kicker: 'Capítulo III',
  title: 'Retratos que se Movem',
  intro: 'Fragmentos de uma história que está apenas começando.',
  /** Retrato ampliado (ao tocar num quadro). */
  viewer: {
    open: 'Ampliar retrato',
    /** Selo com a lupa no quadro da frente. */
    hint: 'Ampliar',
    title: 'Retrato ampliado',
    close: 'Fechar retrato',
    previous: 'Retrato anterior',
    next: 'Próximo retrato',
    /** "3 de 13". */
    of: 'de',
  },
};

/** Capítulo IV — mensagem aos convidados. */
export const guestMessage = {
  kicker: 'Capítulo IV',
  title: 'Palavras de Sofia',
  paragraphs: [
    'Alguns momentos se tornam inesquecíveis porque são compartilhados com pessoas especiais.',
    'Meus 15 anos serão o início de um novo capítulo, e quero viver essa noite cercada por pessoas que fazem parte da minha história.',
    'Prepare-se para uma noite de magia, alegria e memórias que levarei comigo para sempre.',
    'Espero você para celebrar comigo!',
  ],
  signature: event.celebrantFirstName,
};

/** Capítulo V — detalhes práticos. */
export const details = {
  kicker: 'Capítulo V',
  title: 'O Mapa da Celebração',
  whenLabel: 'Quando',
  whereLabel: 'Onde',
  timePending: 'Horário a ser confirmado',
  addressPending: 'O endereço completo será divulgado em breve.',
  mapButton: 'Abrir no mapa',
  /** Rótulo do ícone de localização clicável. */
  mapPinLabel: 'Ver a localização no mapa',
  calendarGoogle: 'Google Agenda',
  calendarIcs: 'Outras agendas',
  dressCodeLabel: 'Traje',
  mapLegend: 'Juro solenemente que irei celebrar',
  /** Cômodos da planta do castelo desenhada no painel central (estilo Mapa do Maroto). */
  mapRooms: {
    library: 'Biblioteca',
    tower: ['Torre da', 'Grifinória'],
    hallway: 'Corredor',
    stairs: 'Grande Escadaria',
    hall: 'Salão Principal',
    entrance: 'Saguão de Entrada',
  },
};

/** Capítulo VI — contagem regressiva. */
export const countdown = {
  kicker: 'Capítulo VI',
  title: 'A Ampulheta',
  intro: 'Cada grão de rubi aproxima a noite encantada.',
  provisionalNote: (tz: string) =>
    `Contagem provisória até 0h do dia da festa (${tz}). O horário oficial será confirmado em breve.`,
  confirmedNote: (time: string, tz: string) => `Contagem até ${time} (${tz}).`,
  todayMessage: 'O grande dia chegou! A magia começa hoje.',
  pastMessage: 'A noite mágica aconteceu. Obrigada a todos que fizeram parte desta história.',
};

/** Capítulo VII — confirmação de presença. */
export const rsvp = {
  kicker: 'Capítulo VII',
  title: 'A Rede de Flu',
  intro: 'Do outro lado da lareira, a Professora Aifos aguarda a resposta da sua família.',
  deadline: (date: string) => `Por gentileza, responda até ${date}.`,
  disabledMessage: 'As confirmações de presença estão encerradas. Em caso de dúvida, fale diretamente com a família.',
  cardTitle: 'Confirme sua presença através do Pó de Flu',
  cardText:
    'Um punhado de Pó de Flu, um nome dito com clareza, e você chega à conversa com a Professora Aifos, no WhatsApp. Ela reconhece a sua família pelo número cadastrado no convite e anota a resposta de todos.',
  steps: ['Responda por você e por quem é da sua família.', 'Mudou de ideia? É só avisar a ela.', 'Pode escrever ou mandar áudio.'],
  button: 'Falar com a Professora Aifos',
  buttonHint: 'Abre o WhatsApp em uma nova aba',
  numberLabel: 'Ou salve o contato:',
  aiNote: 'A Professora Aifos é uma inteligência artificial mágica, criada para receber os convidados.',
  pending: 'O número da Professora Aifos será divulgado em breve pela família.',
  /** Mensagem que já aparece escrita ao abrir a conversa (a pessoa pode editar antes de enviar). */
  greeting: 'Olá, Professora Aifos! Vim pelo convite da Sofia para responder sobre a minha presença.',
  /** Recado para a Sofia (Cofre Pix e Salão Principal): também pela Aifos, que guarda e a família entrega. */
  messageGreeting: 'Olá, Professora Aifos! Quero deixar um recado para a Sofia.',
};

/**
 * Capítulo VIII — lista de presentes. Na página fica só o convite; a lista abre num
 * pergaminho (pop-up). O pagamento é feito na página segura do Asaas.
 */
export const gifts = {
  kicker: 'Capítulo VIII',
  title: 'O Cofre dos Presentes',
  intro: 'Sua presença é o presente mais precioso. Para quem desejar presentear, guardamos a lista num pergaminho encantado.',
  inviteText: 'Presentes encantados, vaquinhas e o Pix da família, tudo enrolado num só pergaminho.',
  openButton: 'Abrir a lista de presentes',

  scrollKicker: 'O Cofre dos Presentes',
  scrollTitle: 'A Lista de Presentes',
  scrollIntro: (installments: number) =>
    `Escolha um presente para ${event.celebrantFirstName}. O pagamento é feito na página segura do Asaas, por Pix ou cartão${installments > 1 ? ` em até ${installments}x` : ''}.`,
  close: 'Fechar a lista de presentes',
  closeShort: 'Fechar',
  demoBadge: 'Lista de demonstração, com presentes fictícios.',
  empty: 'A lista de presentes está sendo preparada com carinho. Volte em breve para conferir as sugestões.',
  /** Resposta da Aifos a "alguém já comprou o presente X?" (ela não vê o que foi pago; vai para os fatos dela). */
  alreadyGiven:
    'Os registros do cofre não chegam até a minha torre, então não consigo ver o que já foi presenteado: conheço apenas o pergaminho encantado com a lista. Mas pode ficar tranquilo: pelo site, cada presente pode ser escolhido por mais de um bruxo, e os galeões de ouro vão direto para o cofre mágico da família. Se ainda restar alguma dúvida sobre isso, o melhor feitiço é conversar direto com os pais da Sofia.',

  quotaTitle: 'Presentes encantados',
  fundTitle: 'Vaquinhas',
  fundHint: 'Contribua com o valor que quiser.',
  freeTitle: 'Sugestões livres',
  freeHint: 'Sem pagamento pelo site: compre onde preferir e leve no dia da festa.',
  freeLink: (store: string | null | undefined) => (store ? `Ver na ${store}` : 'Ver sugestão'),
  giveButton: 'Presentear',
  contributeButton: 'Contribuir',
  raised: (raised: string, goal: string) => `${raised} de ${goal}`,
  goal: (goal: string) => `Meta: ${goal}`,

  back: 'Voltar à lista',
  amountLabel: 'Quanto você quer contribuir?',
  amountHint: (min: string, max: string) => `De ${min} a ${max}.`,
  amountErrors: {
    invalid: 'Digite um valor em reais, por exemplo 150 ou 150,50.',
    min: (min: string) => `O valor mínimo é ${min}.`,
    max: (max: string) => `O valor máximo é ${max}.`,
  },
  payTitle: 'Como você quer pagar?',
  payPix: 'Pix',
  payCard: (installments: number) => (installments > 1 ? `Cartão em até ${installments}x` : 'Cartão'),
  payAmountFirst: 'Digite o valor para ver o total de cada forma de pagamento.',
  payFeesNote: 'Cada total já inclui os custos do Asaas daquela forma de pagamento.',
  messageToggle: `Quero deixar uma mensagem para ${event.celebrantFirstName}`,
  messageLabel: 'Sua mensagem',
  messageCount: (n: number, max: number) => `${n} de ${max} caracteres`,
  signAs: 'Assinar como',
  signAsPlaceholder: 'Seu nome',
  secret: 'Enviar em segredo, sem assinatura',
  signatureMissing: 'Escreva como quer assinar ou escolha enviar em segredo.',
  privacy: `A mensagem entra no Livro de Recados que a família entrega a ${event.celebrantFirstName}, só depois que o pagamento for confirmado.`,
  checkoutNote: 'O pagamento é concluído na página segura do Asaas. Os dados do pagamento ficam só com o Asaas.',
  checkoutSoon: 'Os pagamentos pela lista abrem em breve. Enquanto isso, o Pix da família está no fim do pergaminho.',
  redirecting: 'Abrindo a página segura do Asaas…',
  checkoutErrors: {
    busy: 'Muitas tentativas em pouco tempo. Espere alguns minutos e tente de novo.',
    generic: 'Não foi possível abrir o pagamento agora. Tente de novo em instantes.',
  },
  demoNotice: 'Demonstração: no site publicado, aqui o convidado seguiria para a página do Asaas.',

  thanksTitle: 'Sua coruja partiu!',
  thanksText: 'Obrigado pelo carinho. Assim que o Asaas confirmar o pagamento, o seu presente e a sua mensagem chegam à família.',
  canceledText: 'O pagamento não foi concluído. Se quiser, é só escolher o presente de novo.',
  expiredText: 'O tempo para pagar terminou. Se quiser, é só escolher o presente de novo.',

  pixTitle: 'Cofre Pix',
  pixIntro: 'Prefere enviar qualquer quantia direto para a família? Use a chave Pix abaixo.',
  pixPending: 'A chave Pix será divulgada em breve pela família.',
  pixNoMessage: `O Pix direto não leva mensagem. Quer deixar um recado para ${event.celebrantFirstName}?`,
  pixMessageLink: 'Fale com a Professora Aifos',
};

/**
 * Capítulo IX — O Salão Principal: recados dos convidados, aprovados pela família,
 * flutuando como cartas presas a velas. Selados até o dia da festa.
 */
export const hall = {
  kicker: 'Capítulo IX',
  title: 'O Salão Principal',
  intro: `Sob o teto encantado, as cartas dos convidados flutuam entre as velas, à espera de ${event.celebrantFirstName}.`,
  loading: 'As corujas estão chegando com as cartas…',
  empty: 'Nenhuma carta pendurada ainda. A sua pode ser a primeira.',
  countSealed: (n: number) => (n === 1 ? '1 carta aguarda a noite da festa' : `${n} cartas aguardam a noite da festa`),
  countOpen: (n: number) => (n === 1 ? `1 carta para ${event.celebrantFirstName}` : `${n} cartas para ${event.celebrantFirstName}`),
  sealedNote: (date: string) => `Os selos se rompem em ${date}. Até lá, só a magia sabe o que dizem.`,
  openNote: 'Toque em uma carta para romper o selo e ler.',
  /** Aviso ao tocar numa carta selada (lido também por leitores de tela). */
  sealedTap: (from: string, date: string) => `A carta de ${from} está selada pela magia até ${date}.`,
  letterLabelSealed: (from: string, date: string) => `Carta de ${from}, selada até ${date}`,
  letterLabelOpen: (from: string) => `Abrir a carta de ${from}`,
  letterLabelRead: (from: string) => `Reler a carta de ${from}`,
  from: 'De',
  to: `Para ${event.celebrantFirstName}`,
  signOff: 'Com carinho,',
  ctaTitle: 'Pendure a sua carta no Salão',
  ctaText: 'Conte o seu recado à Professora Aifos. Ela guarda com carinho, e a família escolhe os que sobem ao Salão.',
  ctaButton: 'Escrever a minha carta',
  viewer: {
    title: 'Carta para a Sofia',
    close: 'Fechar a carta',
    previous: 'Carta anterior',
    next: 'Próxima carta',
    of: 'de',
  },
};

/** Capítulo X — encerramento. */
export const closing = {
  kicker: 'Capítulo X',
  title: 'Até Breve',
  message: 'Obrigada por fazer parte desta história. Nos vemos na noite mais mágica do ano.',
  footerSpell: 'Malfeito feito.',
  footerNote: 'Convite criado com carinho para minha amada filha.',
};
