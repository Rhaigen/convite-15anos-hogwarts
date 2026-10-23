// Envia o build (dist/) para a VPS. Ver docs/arquitetura.md#hospedagem.
//
//   npm run deploy:vps                 build de produção + envio
//   npm run deploy:vps -- --dry-run    build e conferências, sem enviar
//   node scripts/deploy-vps.mjs --voltar   volta o site para a versão anterior (sem build)
//
// Configuração em deploy/vps/deploy.env (fora do git; modelo em deploy.env.example):
//   VPS_SSH  nome do Host no ~/.ssh/config (o endereço e a chave ficam só nesta máquina)
//   VPS_DIR  pasta do convite na VPS (a do volume do container Nginx)
//   VPS_URL  endereço público, para conferir depois do envio (opcional)
//
// Cada envio vai para VPS_DIR/releases/<data>-<commit>; o link VPS_DIR/current passa a apontar
// para ela de uma vez (o Nginx serve current/). Ficam as 3 últimas versões, para --voltar.
// A data dos arquivos não é extraída (-m): relógio desta máquina adiantado só gerava avisos.
// O build é feito nesta máquina porque música, fotos da galeria e fotos dos presentes não estão no git.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ENV_FILE = 'deploy/vps/deploy.env';
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const rollback = args.has('--voltar');

if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
const ssh = (process.env.VPS_SSH ?? '').trim();
const dir = (process.env.VPS_DIR ?? '').trim().replace(/\/+$/, '');
const url = (process.env.VPS_URL ?? '').trim().replace(/\/+$/, '');

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};
if (!/^[\w.@-]+$/.test(ssh)) fail(`VPS_SSH ausente ou inválido (defina em ${ENV_FILE}; modelo em deploy.env.example)`);
if (!/^\/[\w./-]+$/.test(dir) || dir.includes('..') || dir.split('/').length < 3) fail('VPS_DIR deve ser um caminho absoluto como /opt/convite-sofia');
if (url && !/^https:\/\/[a-z0-9.-]+$/i.test(url)) fail('VPS_URL deve ser https://dominio, sem caminho');

/**
 * Roda um script sh na VPS. Vai em base64 no argumento (aspas e quebras de linha não sobrevivem
 * à linha de comando do Windows) e o stdin fica livre para o tar.
 */
function remote(script, stdin) {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  return spawn('ssh', ['-o', 'BatchMode=yes', ssh, `sh -c "$(echo ${b64} | base64 -d)"`], {
    stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'inherit'],
  });
}

const output = (child) =>
  new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`saiu com código ${code}`))));
  });

if (rollback) {
  const script = `set -eu
D=${dir}
cur=$(basename "$(readlink "$D/current")")
prev=$(ls -1 "$D/releases" | sort | awk -v c="$cur" '$0 == c { print p; exit } { p = $0 }')
[ -n "$prev" ] || { echo "não há versão anterior a $cur" >&2; exit 1; }
ln -sfn "releases/$prev" "$D/current.tmp"
mv -Tf "$D/current.tmp" "$D/current"
echo "$prev"`;
  const prev = await output(remote(script)).catch((e) => fail(`não consegui voltar a versão (${e.message})`));
  console.log(`✓ site de volta para ${prev}`);
  process.exit(0);
}

// ---- Conferências do build ------------------------------------------------------------------
const DIST = path.resolve('dist');
if (!fs.existsSync(path.join(DIST, 'index.html'))) fail('dist/index.html não existe: rode o build (npm run deploy:vps já faz)');
const warnings = [];
if (!fs.existsSync(path.join(DIST, 'audio', 'tema.mp3'))) warnings.push('sem dist/audio/tema.mp3: o site vai sem música');
const photos = fs.existsSync(path.join(DIST, 'presentes')) ? fs.readdirSync(path.join(DIST, 'presentes')).length : 0;
if (photos === 0) warnings.push('sem dist/presentes/: o checkout do Asaas vai mostrar o brasão (npm run gifts:images)');
const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
if (url && !html.includes(url)) warnings.push(`o index.html não cita ${url}: siteMeta.url (site.ts) ainda não é o domínio?`);

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const commit = git('rev-parse', '--short', 'HEAD');
const branch = git('branch', '--show-current');
if (git('status', '--porcelain')) warnings.push('há alterações sem commit: o envio leva o build delas');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const release = `${stamp}-${commit}`;

console.log(`Convite → ${ssh}:${dir}/releases/${release}  (branch ${branch})`);
for (const w of warnings) console.warn(`! ${w}`);
if (dryRun) {
  console.log('--dry-run: nada foi enviado.');
  process.exit(0);
}

// ---- Envio: tar.gz pelo ssh, extraído numa pasta nova; depois o link troca de uma vez ---------
const script = `set -eu
D=${dir}
R="$D/releases/${release}"
mkdir -p "$R"
tar -xzmf - -C "$R"
test -f "$R/index.html"
chmod -R a+rX "$R"
ln -sfn "releases/${release}" "$D/current.tmp"
mv -Tf "$D/current.tmp" "$D/current"
ls -1 "$D/releases" | sort | head -n -3 | while read -r old; do rm -rf -- "$D/releases/$old"; done
du -sh "$R" | cut -f1`;

const tar = spawn('tar', ['-czf', '-', '--exclude=_headers', '-C', DIST, '.'], { stdio: ['ignore', 'pipe', 'inherit'] });
const upload = remote(script, true);
tar.stdout.pipe(upload.stdin);
tar.on('close', (code) => {
  if (code !== 0) {
    upload.kill();
    fail(`tar saiu com código ${code}`);
  }
});
const size = await output(upload).catch((e) => fail(`envio falhou (${e.message}); o site continua na versão anterior`));
console.log(`✓ ${release} no ar (${size})`);

// ---- Conferência pública ---------------------------------------------------------------------
if (url) {
  const check = async (p, type) => {
    const res = await fetch(`${url}${p}`, { method: 'HEAD', redirect: 'manual' }).catch(() => null);
    const ok = res?.status === 200 && (!type || (res.headers.get('content-type') ?? '').startsWith(type));
    console.log(`${ok ? '✓' : '✗'} ${url}${p} → ${res ? `${res.status} ${res.headers.get('content-type') ?? ''}` : 'sem resposta'}`);
    return ok;
  };
  const firstPhoto = photos ? `/presentes/${fs.readdirSync(path.join(DIST, 'presentes'))[0]}` : null;
  const results = [await check('/', 'text/html'), ...(firstPhoto ? [await check(firstPhoto, 'image/png')] : [])];
  if (results.includes(false)) process.exitCode = 1;
}
