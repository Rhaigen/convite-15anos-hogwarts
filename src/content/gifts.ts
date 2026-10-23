/**
 * ============================================================================
 *  LISTA DE PRESENTES (abre num pergaminho a partir do Capítulo VIII)
 * ============================================================================
 *  Três tipos de presente. Os valores são em reais e são o que a FAMÍLIA
 *  RECEBE (é o valor exibido); ao presentear, os botões Pix e Cartão mostram
 *  o total com os custos do Asaas (settings.ts → giftsConfig.fees).
 *
 *  Cota (preço fixo; vários convidados podem escolher a mesma):
 *  { kind: 'quota', id: 'varinha', name: 'Uma varinha nova', description: 'Opcional.', icon: 'wand', amount: 150 },
 *
 *  Vaquinha (cada um contribui com quanto quiser; o site mostra "R$ X de R$ Y"):
 *  { kind: 'fund', id: 'viagem', name: 'A viagem dos sonhos', icon: 'plane', goal: 5000 },
 *
 *  Sugestão livre (sem pagamento pelo site; link opcional):
 *  { kind: 'free', id: 'livros', name: 'Livros da saga', url: 'https://loja.exemplo/livro', storeName: 'Loja' },
 *
 *  `id`: letras minúsculas, números e hífen, sem repetir (vai para o banco).
 *  Ícones: gift, wand, book, plane, camera, music, gem, shirt, sparkles, crown,
 *  feather, cake, heart, star, watch.
 *
 *  Foto (opcional): `image: 'arquivo.png'`, o nome do arquivo em presentes-originais/
 *  (sem acentos nem espaços); depois `npm run gifts:images`. Sem a foto gerada, o cartão
 *  mostra o ícone e o checkout do Asaas, o brasão (a foto do checkout é buscada no site
 *  publicado: faça o build novo antes de republicar gift-checkout).
 *
 *  DEPOIS DE MUDAR: `npm run agent:facts` (o servidor usa uma cópia desta
 *  lista para conferir os preços; o teste acusa se esquecer) e republicar as
 *  funções gift-checkout e site-gifts.
 * ============================================================================
 */
import type { Gift } from '../types/content.ts';

export const giftList: Gift[] = [
  { kind: 'fund', id: 'dia-de-princesa', name: 'Dia de princesa', icon: 'crown', goal: 1700 },
  { kind: 'fund', id: 'hotel-flamboyant', name: '3 dias no Hotel Flamboyant', icon: 'plane', goal: 3179.18 },
  { kind: 'quota', id: 'fone-qcy-ht08-pro', name: 'Fone Bluetooth QCY HT08 Pro', icon: 'music', image: 'fone-qcy-HT08-pro.png', amount: 273 },
  {
    kind: 'quota',
    id: 'tenis-vans-vero-ls',
    name: 'Tênis Vans Feminino Vero LS Preto',
    description: 'Tamanho 39–40.',
    icon: 'star',
    image: 'tenis-vans-verols-preto.png',
    amount: 379.9,
  },
  {
    kind: 'quota',
    id: 'tenis-adidas-breaknet',
    name: 'Tênis Adidas Breaknet Feminino Off White',
    description: 'Tamanho 39–40.',
    icon: 'star',
    image: 'tenis-adidas-breaknet-feminino-offwhite.png',
    amount: 219.99,
  },
  { kind: 'quota', id: 'smartwatch-amazfit-gtr2', name: 'Smartwatch Amazfit GTR 2', icon: 'watch', image: 'smartwatch-amazfit-gtr2.png', amount: 799 },
  { kind: 'quota', id: 'smartwatch-haylou-4s', name: 'Smartwatch Haylou Watch 4S', icon: 'watch', image: 'smartwatch-haylou-watch4s.png', amount: 308.7 },
  {
    kind: 'quota',
    id: 'instax-mini-12',
    name: 'Câmera Instantânea Fujifilm Instax Mini 12 Lilás',
    icon: 'camera',
    image: 'instax-mini-12-lilas.png',
    amount: 532,
  },
  {
    kind: 'quota',
    id: 'perfume-granado-madreperola',
    name: 'Perfume Granado Madrepérola 75ml',
    icon: 'sparkles',
    image: 'perfume-granado-madreperola.png',
    amount: 365,
  },
  { kind: 'quota', id: 'perfume-her-code', name: 'Her Code Eau de Parfum 50ml', icon: 'sparkles', image: 'perfume-oboticario-hercode.png', amount: 220 },
  {
    kind: 'quota',
    id: 'perfume-coffee-woman-duo',
    name: 'Perfume Coffee Woman Duo 100ml',
    icon: 'sparkles',
    image: 'perfume-coffee-woman-duo.png',
    amount: 184.99,
  },
  { kind: 'quota', id: 'camera-digital-mini-retro', name: 'Câmera Digital Mini Retrô', icon: 'camera', image: 'camera-digital-mini-retro.png', amount: 120 },
  {
    kind: 'quota',
    id: 'livro-melhor-do-que-nos-filmes',
    name: 'Livro Melhor do Que nos Filmes',
    icon: 'book',
    image: 'livro-melhordoquenosfilmes.png',
    amount: 43.86,
  },
  {
    kind: 'quota',
    id: 'livro-nao-e-como-nos-filmes',
    name: 'Livro Não é Como nos Filmes',
    icon: 'book',
    image: 'livro-naoecomonosfilmes.png',
    amount: 43.84,
  },

  { kind: 'free', id: 'acessorios', name: 'Acessórios', description: 'De preferência prata.', icon: 'gem' },
  { kind: 'free', id: 'perfumes-doces', name: 'Perfumes', description: 'De fragrância doce.', icon: 'sparkles' },
  { kind: 'free', id: 'livros-romance', name: 'Livros de romance', icon: 'book' },
  { kind: 'free', id: 'livros-suspense', name: 'Livros de suspense', icon: 'book' },
  { kind: 'free', id: 'livros-ficcao', name: 'Livros de ficção', icon: 'book' },
  { kind: 'free', id: 'fones-tws', name: 'Fones de ouvido TWS', description: 'Intra-auriculares.', icon: 'music' },
  { kind: 'free', id: 'tenis-vans', name: 'Tênis estilo Vans', description: 'Preto, tamanho 39–40.', icon: 'star' },
  { kind: 'free', id: 'tenis-adidas', name: 'Tênis estilo Adidas', description: 'Branco, tamanho 39–40.', icon: 'star' },
  { kind: 'free', id: 'kindle', name: 'Kindle', icon: 'book' },
  { kind: 'free', id: 'sandalia-crocs', name: 'Sandália Crocs', icon: 'star' },
];
