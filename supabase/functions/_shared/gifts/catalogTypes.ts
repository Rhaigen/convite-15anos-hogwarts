/**
 * Formato do catálogo da lista de presentes no servidor (o arquivo catalog.ts é GERADO
 * por `npm run agent:facts` a partir de src/content/gifts.ts e settings.ts).
 * As sugestões livres não entram: não têm pagamento.
 */
import type { FeeTable } from './pricing.ts';

interface CatalogBase {
  id: string;
  name: string;
  /** Nome no checkout do Asaas (até 30 caracteres). */
  checkoutName: string;
  /** Descrição no checkout do Asaas (até 150 caracteres). */
  checkoutDescription: string;
  /**
   * Foto do item no checkout: caminho do PNG no próprio convite (`npm run gifts:images` gera
   * em public/presentes/). Só o caminho: as fotos não vão para o repositório.
   */
  photo?: string;
}

export interface CatalogQuota extends CatalogBase {
  kind: 'quota';
  /** Quanto a família recebe. */
  amountCents: number;
}

export interface CatalogFund extends CatalogBase {
  kind: 'fund';
  goalCents: number;
}

export type CatalogGift = CatalogQuota | CatalogFund;

export interface GiftCatalog {
  maxInstallments: number;
  fees: FeeTable;
  fundMinCents: number;
  fundMaxCents: number;
  gifts: CatalogGift[];
}
