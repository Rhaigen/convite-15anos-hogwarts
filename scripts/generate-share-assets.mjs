/**
 * Imagem de compartilhamento do link (brasão da Sofia), ícone da aba e apple-touch-icon:
 *   npm run share
 * Detalhes em scripts/lib/share-image.ts.
 */
import { runnerImport } from 'vite';

const { module } = await runnerImport('./scripts/lib/share-image.ts', { configFile: false, logLevel: 'error' });
await module.main();
