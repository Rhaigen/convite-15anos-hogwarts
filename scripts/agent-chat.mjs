/**
 * Simulador da Professora Aifos no terminal:
 *   npm run agent:chat [-- --effort low|medium|high] [--como carlos] [--verbose]
 * Usa o Claude Haiku 5.5 de verdade (ANTHROPIC_API_KEY ou supabase/functions/.env)
 * e um banco PGlite em memória com convidados fictícios. Detalhes em scripts/lib/agent-sim.ts.
 */
import { runnerImport } from 'vite';

const { module } = await runnerImport('./scripts/lib/agent-sim.ts', { configFile: false, logLevel: 'error' });
await module.main(process.argv.slice(2));
