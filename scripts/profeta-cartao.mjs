/**
 * Cartões das mesas d'O Profeta Diário (QR + palavra mágica), em profeta-cartao/ (fora do git):
 *   npm run profeta:cartao -- --senha "palavra mágica"
 * Detalhes em scripts/lib/profeta-card.ts.
 */
import { runnerImport } from 'vite';

const { module } = await runnerImport('./scripts/lib/profeta-card.ts', { configFile: false, logLevel: 'error' });
await module.main(process.argv.slice(2));
