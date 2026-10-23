/**
 * Imagem de compartilhamento do link (1200×630): o brasão pessoal da Sofia, prata e roxo, no clima do
 * Capítulo X, com nome e data em prata. Desenhada em HTML com as fontes do site e fotografada pelo
 * Chrome; também refaz os ícones: o da aba (só o escudo roxo com o S, que se lê em 16 px) e o
 * apple-touch-icon (180×180, o brasão inteiro).
 *
 *   npm run share
 *
 * Trocou a imagem? Mude o nome do arquivo (OG_FILE e siteMeta.ogImage): o WhatsApp e as outras redes
 * guardam a prévia pelo endereço da imagem. O mesmo vale para o ícone da aba (FAVICON_NAME).
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { event } from '../../src/content/event.ts';
import { siteMeta } from '../../src/content/site.ts';
import { formatDateMedium } from '../../src/lib/date.ts';

const CREST = 'src/assets/brasoes/sofia-512.webp';
/** Ícone da aba: public/<nome>-<tamanho>.png, ligados em index.html e profeta/index.html. */
const FAVICON_NAME = 'favicon-sofia';
const FAVICON_SIZES = [32, 48, 192];
/** Contorno do escudo dentro do recorte (360×380 a partir de 80,195 no brasão de 512 px). */
const SHIELD = { left: 80, top: 195, width: 360, height: 380, path: 'M16,38 Q180,8 340,38 L338,190 Q330,300 180,364 Q30,300 21,190 Z' };

const fileUrl = (path: string) => pathToFileURL(resolve(path)).href;
const font = (file: string) => fileUrl(join('node_modules', file));
const escapeHtml = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function shareHtml(): string {
  const surname = event.celebrant.slice(event.celebrantFirstName.length).trim();
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<style>
  @font-face { font-family: 'Cinzel'; src: url('${font('@fontsource-variable/cinzel/files/cinzel-latin-wght-normal.woff2')}') format('woff2'); font-weight: 400 900; }
  @font-face { font-family: 'Cormorant'; src: url('${font('@fontsource/cormorant-garamond/files/cormorant-garamond-latin-500-italic.woff2')}') format('woff2'); font-style: italic; }
  * { box-sizing: border-box; margin: 0; }
  body { width: 1200px; height: 630px; overflow: hidden; color: #f8f0e2; font-family: 'Cormorant', Georgia, serif;
    background: radial-gradient(70% 80% at 28% 50%, rgba(96, 44, 168, 0.5), transparent 75%),
      radial-gradient(60% 70% at 75% 45%, rgba(116, 15, 32, 0.28), transparent 75%), #100a12; }
  .halo { position: absolute; left: 70px; top: 40px; width: 550px; height: 550px; border-radius: 50%;
    background: radial-gradient(closest-side, rgba(232, 226, 246, 0.34), rgba(140, 92, 200, 0.14) 55%, transparent 100%); }
  .crest { position: absolute; left: 180px; top: 55px; height: 520px; filter: drop-shadow(0 14px 26px rgba(0, 0, 0, 0.6)); }
  .frame { position: absolute; inset: 22px; border: 2px solid rgba(205, 196, 226, 0.5); }
  .frame::after { content: ''; position: absolute; inset: 8px; border: 1px solid rgba(216, 177, 90, 0.25); }
  .text { position: absolute; left: 600px; top: 150px; width: 540px; display: flex; flex-direction: column; align-items: center; gap: 14px; text-align: center; }
  .kicker { font-family: 'Cinzel'; font-size: 24px; letter-spacing: 0.32em; padding-left: 0.32em; color: #c9bde4; }
  .name { font-family: 'Cinzel'; font-weight: 800; font-size: 118px; line-height: 0.95; letter-spacing: 0.06em; color: transparent;
    background: linear-gradient(170deg, #ffffff 0%, #e4e1ec 28%, #9d97ad 52%, #f1eff6 74%, #8a8499 100%);
    -webkit-background-clip: text; background-clip: text; filter: drop-shadow(0 3px 10px rgba(0, 0, 0, 0.55)); }
  .surname { font-family: 'Cinzel'; font-size: 28px; letter-spacing: 0.28em; padding-left: 0.28em; }
  .rule { width: 300px; height: 1px; margin: 6px 0; background: linear-gradient(90deg, transparent, #b9a8dc, transparent); }
  .date { font-style: italic; font-size: 38px; color: #ddd2f2; }
</style>
</head>
<body>
  <div class="halo"></div>
  <img class="crest" src="${fileUrl(CREST)}" alt="" />
  <div class="frame"></div>
  <div class="text">
    <p class="kicker">CONVITE · XV ANOS</p>
    <p class="name">${escapeHtml(event.celebrantFirstName.toUpperCase())}</p>
    <p class="surname">${escapeHtml(surname.toUpperCase())}</p>
    <div class="rule"></div>
    <p class="date">${escapeHtml(formatDateMedium(event.date))}</p>
  </div>
</body>
</html>
`;
}

export async function main(): Promise<void> {
  const chrome =
    process.env.CHROME_PATH ??
    ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => existsSync(p));
  if (!chrome) throw new Error('Chrome não encontrado: defina CHROME_PATH.');

  const ogFile = join('public', siteMeta.ogImage);
  const dir = mkdtempSync(join(tmpdir(), 'og-'));
  const htmlPath = join(dir, 'og.html');
  writeFileSync(htmlPath, shareHtml());
  const browser = await chromium.launch({ executablePath: chrome });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const png = await page.screenshot();
    await sharp(png).jpeg({ quality: 86, mozjpeg: true }).toFile(ogFile);
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }

  const { left, top, width, height, path } = SHIELD;
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><path d="${path}" fill="#fff"/></svg>`);
  const shield = await sharp(CREST).extract({ left, top, width, height }).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
  for (const size of FAVICON_SIZES) {
    await sharp(shield).trim().resize(size, size, { fit: 'contain', background: transparent }).png().toFile(`public/${FAVICON_NAME}-${size}.png`);
  }

  // Tela inicial do celular: o brasão inteiro, com respiro, sobre o fundo escuro do site.
  const crest = await sharp(CREST).trim().resize(150, 150, { fit: 'contain', background: transparent }).toBuffer();
  await sharp({ create: { width: 180, height: 180, channels: 4, background: '#100a12' } })
    .composite([{ input: crest, gravity: 'center' }])
    .png()
    .toFile('public/apple-touch-icon.png');
  console.log(`✓ ${ogFile}  ✓ public/${FAVICON_NAME}-{${FAVICON_SIZES.join(',')}}.png  ✓ public/apple-touch-icon.png`);
}
