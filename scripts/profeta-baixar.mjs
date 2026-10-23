// Baixa da VPS tudo d'O Profeta Diário para profeta-fotos/<data>/ (fora do git: fotos dos convidados).
// É o backup depois da festa e a base para um álbum da família.
//
//   npm run profeta:baixar
//
// Traz edicao.json e midia/ como estão na VPS e monta album/ com as fotos (versão grande) e os
// vídeos publicados, com nomes legíveis: "037-foto-Tia-Marta.jpg". As retiradas pelos organizadores
// vão para album/retiradas/. Usa VPS_SSH e PROFETA_DIR de deploy/vps/deploy.env.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ENV_FILE = 'deploy/vps/deploy.env';
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
const ssh = (process.env.VPS_SSH ?? '').trim();
const dir = (process.env.PROFETA_DIR ?? '/opt/convite-profeta').trim().replace(/\/+$/, '');
if (!/^[\w.@-]+$/.test(ssh)) {
  console.error(`✗ VPS_SSH ausente ou inválido (defina em ${ENV_FILE})`);
  process.exit(1);
}

const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
const out = path.join('profeta-fotos', stamp);
fs.mkdirSync(out, { recursive: true });

console.log(`Baixando ${ssh}:${dir}/dados → ${out}`);
const remote = spawn('ssh', ['-o', 'BatchMode=yes', ssh, `tar -czf - -C ${dir}/dados edicao.json midia`], { stdio: ['ignore', 'pipe', 'inherit'] });
const local = spawn('tar', ['-xzf', '-', '-C', out], { stdio: ['pipe', 'inherit', 'inherit'] });
remote.stdout.pipe(local.stdin);
const codes = await Promise.all([new Promise((r) => remote.on('close', r)), new Promise((r) => local.on('close', r))]);
if (codes.some((c) => c !== 0)) {
  console.error('✗ download falhou');
  process.exit(1);
}

const slug = (v) =>
  (v ?? 'convidado')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\w]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'convidado';

const { items } = JSON.parse(fs.readFileSync(path.join(out, 'edicao.json'), 'utf8'));
const album = path.join(out, 'album');
fs.mkdirSync(path.join(album, 'retiradas'), { recursive: true });
let copied = 0;
for (const item of items) {
  if (item.status !== 'pronta' || !item.files) continue;
  const source = item.files.grande ?? item.files.video;
  const from = path.join(out, 'midia', source);
  if (!fs.existsSync(from)) continue;
  const name = `${String(item.n).padStart(3, '0')}-${item.kind}-${slug(item.author)}${path.extname(source)}`;
  fs.copyFileSync(from, path.join(album, item.removedAt ? 'retiradas' : '', name));
  copied++;
}
console.log(`✓ ${items.length} itens na edição; ${copied} arquivos em ${album}`);
