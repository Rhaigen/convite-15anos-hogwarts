// Verifica se o build (dist/) contém segredos que nunca devem chegar ao navegador:
// service_role JWT, chaves secretas sb_secret_*, chave do Asaas, chaves privadas e arquivos .env
// (e os presentes fictícios de demonstração, que só existem no dev e no e2e).
import fs from 'node:fs';
import path from 'node:path';

const dist = path.resolve('dist');
if (!fs.existsSync(dist)) {
  console.error('dist/ não encontrado. Rode "npm run build" antes.');
  process.exit(1);
}

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push(full);
  }
})(dist);

const problems = [];
const notes = [];
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

for (const file of files) {
  const rel = path.relative(dist, file);
  if (/(^|[\\/])\.env/.test(rel)) problems.push(`${rel}: arquivo de ambiente publicado`);
  if (!/\.(js|mjs|html|css|json|txt|map)$/.test(file)) continue;
  const text = fs.readFileSync(file, 'utf8');

  for (const token of text.match(JWT) ?? []) {
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      if (payload.role === 'service_role') problems.push(`${rel}: JWT com role=service_role`);
      else notes.push(`${rel}: JWT público (role=${payload.role ?? '?'})`);
    } catch {
      /* não é um JWT válido */
    }
  }
  if (/sb_secret_[A-Za-z0-9_-]{16,}/.test(text)) problems.push(`${rel}: chave secreta sb_secret_*`);
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) problems.push(`${rel}: chave privada`);
  if (/SUPABASE_SERVICE_ROLE_KEY\s*[=:]\s*["']?[A-Za-z0-9]/.test(text)) problems.push(`${rel}: variável SERVICE_ROLE preenchida`);
  if (/\$aact_[A-Za-z0-9_]{8,}/.test(text)) problems.push(`${rel}: chave da API do Asaas`);
  if (/Presentes FICTÍCIOS|mandrágora/.test(text)) problems.push(`${rel}: presentes de demonstração (scripts/fixtures) no build`);
}

notes.forEach((n) => console.log(`ℹ ${n}`));
if (problems.length) {
  console.error('✗ Segredos encontrados no build:');
  problems.forEach((p) => console.error(`  - ${p}`));
  process.exit(1);
}
console.log(`✓ Nenhum segredo encontrado em ${files.length} arquivos de dist/.`);
