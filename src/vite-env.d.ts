/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SITE_URL?: string;
  readonly VITE_ALLOW_INDEXING?: string;
  /** Endereço das cartas do Salão Principal (sobrepõe messageWallConfig.endpoint). */
  readonly VITE_MESSAGES_URL?: string;
  /** Funções da lista de presentes (sobrepõem giftsConfig; usadas pelo e2e). */
  readonly VITE_GIFT_CHECKOUT_URL?: string;
  readonly VITE_GIFT_PROGRESS_URL?: string;
}

/**
 * Lista de presentes FICTÍCIA (scripts/fixtures/presentes-demo.json) no build: só o e2e liga
 * (VITE_E2E_GIFTS_DEMO=true). Constante do vite.config.ts: falsa, o código some do build.
 */
declare const __GIFTS_DEMO__: boolean;

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
