// Envia o serviço d'O Profeta Diário (services/profeta) para a VPS e constrói a imagem lá.
// Ver docs/arquitetura.md#hospedagem → "O Profeta Diário".
//
//   npm run deploy:profeta               envio + docker build + reinício (PROFETA_RESTART)
//   npm run deploy:profeta -- --dry-run  só as conferências
//
// Configuração em deploy/vps/deploy.env (fora do git), além de VPS_SSH e VPS_URL:
//   PROFETA_DIR      pasta do serviço na VPS (padrão /opt/convite-profeta); o código vai para app/<versão>
//   PROFETA_RESTART  comando, na VPS, que troca o container pela imagem nova (o agente da VPS define;
//                    ex.: docker service update --force --image convite-profeta:latest convite-profeta_profeta)
//
// Os dados (fotos, vídeos, edicao.json) ficam em PROFETA_DIR/dados, no disco de tamanho fixo: este
// envio nunca toca neles. Sem npm na VPS: o serviço não tem dependências (Node 24 roda o TypeScript).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';

const ENV_FILE = 'deploy/vps/deploy.env';
const dryRun = process.argv.includes('--dry-run');

if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
const ssh = (process.env.VPS_SSH ?? '').trim();
const dir = (process.env.PROFETA_DIR ?? '/opt/convite-profeta').trim().replace(/\/+$/, '');
const restart = (process.env.PROFETA_RESTART ?? '').trim();
const url = (process.env.VPS_URL ?? '').trim().replace(/\/+$/, '');

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};
if (!/^[\w.@-]+$/.test(ssh)) fail(`VPS_SSH ausente ou inválido (defina em ${ENV_FILE}; modelo em deploy.env.example)`);
if (!/^\/[\w./-]+$/.test(dir) || dir.includes('..') || dir.split('/').length < 3) fail('PROFETA_DIR deve ser um caminho absoluto como /opt/convite-profeta');
if (restart && /[`]/.test(restart)) fail('PROFETA_RESTART não pode ter crases');

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const commit = git('rev-parse', '--short', 'HEAD');
if (git('status', '--porcelain', 'services/profeta')) console.warn('! services/profeta tem alterações sem commit: o envio leva o que está no disco');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const release = `${stamp}-${commit}`;

console.log(`Profeta → ${ssh}:${dir}/app/${release}${restart ? '' : '  (sem PROFETA_RESTART: só constrói a imagem)'}`);
if (dryRun) {
  console.log('--dry-run: nada foi enviado.');
  process.exit(0);
}

/** Script sh na VPS em base64 (aspas e quebras de linha não sobrevivem à linha de comando do Windows). */
function remote(script, stdin) {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  return spawn('ssh', ['-o', 'BatchMode=yes', ssh, `sh -c "$(echo ${b64} | base64 -d)"`], { stdio: [stdin ? 'pipe' : 'ignore', 'inherit', 'inherit'] });
}

const script = `set -eu
D=${dir}
R="$D/app/${release}"
mkdir -p "$R"
tar -xzmf - -C "$R"
test -f "$R/Dockerfile"
docker build -q -t convite-profeta:${release} -t convite-profeta:latest "$R"
ls -1 "$D/app" | sort | head -n -3 | while read -r old; do rm -rf -- "$D/app/$old"; done
${restart ? `${restart}\n` : ''}echo "imagem convite-profeta:${release} pronta"`;

const tar = spawn('tar', ['-czf', '-', '--exclude=node_modules', '-C', 'services/profeta', '.'], { stdio: ['ignore', 'pipe', 'inherit'] });
const upload = remote(script, true);
tar.stdout.pipe(upload.stdin);
const code = await new Promise((r) => upload.on('close', r));
if (code !== 0) fail(`envio ou build falhou (código ${code}); o serviço continua na versão anterior`);
console.log(`✓ ${release}`);

if (url && restart) {
  await new Promise((r) => setTimeout(r, 4000));
  const res = await fetch(`${url}/api/profeta/saude`).catch(() => null);
  const ok = res?.status === 200;
  console.log(`${ok ? '✓' : '✗'} ${url}/api/profeta/saude → ${res ? res.status : 'sem resposta'}`);
  if (!ok) process.exitCode = 1;
}
