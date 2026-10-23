/**
 * Serviço do Profeta Diário: recebe as fotos e vídeos dos convidados (pelo site e pela Aifos) e
 * entrega a edição. Roda num container próprio na VPS (stack convite-profeta), com os dados num
 * disco de tamanho fixo. Ver docs/arquitetura.md#o-profeta-diario e docs/arquitetura.md#hospedagem.
 */
import fs from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { readConfig } from './config.ts';
import { createMediaDownloader } from './evolution.ts';
import { createProcessor } from './media.ts';
import { createHandler } from './server.ts';
import { createStore } from './store.ts';

const config = readConfig(process.env);
const dirs = { tmp: path.join(config.dataDir, 'tmp'), media: path.join(config.dataDir, 'midia') };
fs.mkdirSync(dirs.tmp, { recursive: true });
fs.mkdirSync(dirs.media, { recursive: true });

const store = createStore(config.dataDir);
// Brutos órfãos (pedido interrompido antes de entrar na lista) não ocupam a cota para sempre.
const queuedRaw = new Set(store.queued().map((i) => i.rawFile));
for (const name of fs.readdirSync(dirs.tmp)) if (!queuedRaw.has(name)) fs.rmSync(path.join(dirs.tmp, name), { force: true });

const processor = createProcessor(store, dirs);
processor.resume();

const handler = createHandler({
  config,
  store,
  processor,
  dirs,
  freeBytes: async () => {
    try {
      const s = await fs.promises.statfs(config.dataDir);
      return s.bavail * s.bsize;
    } catch {
      return null;
    }
  },
  downloadWhatsApp: config.evolution ? createMediaDownloader(config.evolution) : undefined,
});

const server = createServer((req, res) => void handler(req, res));
// Envio de vídeo no 4G da festa pode demorar: tempo generoso por pedido, mas não infinito.
server.requestTimeout = 10 * 60_000;
server.headersTimeout = 30_000;
server.listen(config.port, () => {
  console.warn(`Profeta Diário na porta ${config.port}; ${store.all().length} itens; janela ${config.opensAt.toISOString()} → ${config.closesAt.toISOString()}`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
