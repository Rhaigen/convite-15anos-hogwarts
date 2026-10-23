/**
 * Metadados de compartilhamento e a lista de capítulos usada na navegação.
 * Também é lido pelo build (vite.config.ts) — mantenha sem APIs de navegador.
 */
import { event } from './event.ts';
import { formatDateMedium } from '../lib/date.ts';

export const siteMeta = {
  /**
   * Endereço público do convite (ex.: 'https://sofia15anos.com.br'), quando estiver no ar.
   * Usado nos metadados de compartilhamento (VITE_SITE_URL, se definida, tem prioridade) e
   * pela Professora Aifos, que envia o link a quem pedir (rode `npm run agent:facts`).
   */
  url: 'https://convite.example.com' as string | null,
  title: `${event.celebrant} · 15 anos`,
  description: `Você recebeu uma carta especial. Abra o convite mágico para celebrar os 15 anos de ${event.celebrant} em ${formatDateMedium(event.date)}, no ${event.venue}.`,
  /** Gerada por `npm run share` (1200×630). Trocou a imagem? Mude o nome: as redes guardam a prévia pelo endereço. */
  ogImage: '/og-sofia.jpg',
  ogImageAlt: `Brasão prata e roxo de ${event.celebrantFirstName}, ao lado do nome e da data do convite de 15 anos`,
  themeColor: '#100A12',
};

export interface Chapter {
  id: string;
  numeral: string;
  label: string;
}

/** Ordem e âncoras dos capítulos (ids usados como #âncora na URL). */
export const chapters: Chapter[] = [
  { id: 'carta', numeral: '✦', label: 'A Carta' },
  { id: 'travessia', numeral: 'I', label: 'A Travessia' },
  { id: 'grifinoria', numeral: 'II', label: 'A Casa da Coragem' },
  { id: 'retratos', numeral: 'III', label: 'Retratos que se Movem' },
  { id: 'mensagem', numeral: 'IV', label: 'Palavras de Sofia' },
  { id: 'celebracao', numeral: 'V', label: 'O Mapa da Celebração' },
  { id: 'contagem', numeral: 'VI', label: 'A Ampulheta' },
  { id: 'presenca', numeral: 'VII', label: 'Confirmar Presença' },
  { id: 'presentes', numeral: 'VIII', label: 'Lista de Presentes' },
  { id: 'salao', numeral: 'IX', label: 'O Salão Principal' },
  { id: 'encerramento', numeral: 'X', label: 'Até Breve' },
];
