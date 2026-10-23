/**
 * Livro de Recados para a Sofia (recados guardados pela Professora Aifos):
 *   npm run messages:book            # banco real (.env.local) → recados/
 *   npm run messages:book -- --demo  # convidados fictícios → test-results/
 * Detalhes em scripts/lib/messages-book.ts.
 */
import { runnerImport } from 'vite';

const { module } = await runnerImport('./scripts/lib/messages-book.ts', { configFile: false, logLevel: 'error' });
await module.main(process.argv.slice(2));
