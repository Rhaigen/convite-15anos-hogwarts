/**
 * Avaliação da Professora Aifos com o Claude Haiku 5.5 de verdade:
 *   npm run agent:eval [-- --cenario injecao,sapo] [--vezes 3] [--effort low|medium|high] [--paralelo 4]
 * Cenários em scripts/lib/agent-eval-scenarios.ts; detalhes em scripts/lib/agent-eval.ts.
 */
import { runnerImport } from 'vite';

const { module } = await runnerImport('./scripts/lib/agent-eval.ts', { configFile: false, logLevel: 'error' });
await module.main(process.argv.slice(2));
