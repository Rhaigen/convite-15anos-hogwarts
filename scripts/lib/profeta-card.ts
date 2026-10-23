/**
 * Cartões das mesas d'O Profeta Diário: folha A4 com 4 cartões A6 (linhas de corte), cada um com o
 * QR do jornal, a palavra mágica e o WhatsApp da Professora Aifos. Sai em profeta-cartao/ (fora do
 * git: a palavra mágica é segredo). Sem a palavra, fica uma linha para escrever à mão.
 *
 *   npm run profeta:cartao -- --senha "palavra mágica"     (ou PROFETA_SENHA no ambiente)
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import QRCode from 'qrcode';
import { event } from '../../src/content/event.ts';
import { profetaConfig, profetaTexts } from '../../src/content/profeta.ts';
import { rsvpConfig } from '../../src/content/settings.ts';
import { siteMeta } from '../../src/content/site.ts';
import { formatWhatsappNumber } from '../../src/lib/whatsapp.ts';

const OUT = 'profeta-cartao';

const escapeHtml = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const font = (file: string) => pathToFileURL(resolve('node_modules', file)).href;

export function cardHtml(pageUrl: string, qrSvg: string, password: string | null, whatsapp: string | null): string {
  const card = `
    <section class="card">
      <p class="rail">${escapeHtml(profetaTexts.kicker)}</p>
      <h1>${escapeHtml(profetaTexts.masthead)}</h1>
      <p class="lead">Fotografou? Mande ao Profeta!</p>
      <div class="qr">${qrSvg}</div>
      <p class="hint">Aponte a câmera do celular para o código</p>
      <p class="magic">Palavra mágica: ${password ? `<strong>${escapeHtml(password)}</strong>` : '<span class="blank"></span>'}</p>
      <p class="small">Fotos e vídeos de até ${profetaConfig.maxVideoSeconds} segundos aparecem no jornal para todos os convidados.${
        whatsapp ? ` Ou envie direto para a Professora Aifos no WhatsApp: <strong>${escapeHtml(whatsapp)}</strong>.` : ''
      }</p>
      <p class="url">${escapeHtml(pageUrl.replace(/^https:\/\//, ''))}</p>
    </section>`;
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(profetaTexts.masthead)} · cartões das mesas · ${escapeHtml(event.celebrantFirstName)}</title>
<style>
  @font-face { font-family: 'Cinzel'; src: url('${font('@fontsource-variable/cinzel/files/cinzel-latin-wght-normal.woff2')}') format('woff2'); font-weight: 400 900; }
  @font-face { font-family: 'Cormorant'; src: url('${font('@fontsource/cormorant-garamond/files/cormorant-garamond-latin-500-normal.woff2')}') format('woff2'); font-weight: 500; }
  @font-face { font-family: 'Cormorant'; src: url('${font('@fontsource/cormorant-garamond/files/cormorant-garamond-latin-600-normal.woff2')}') format('woff2'); font-weight: 600; }
  @font-face { font-family: 'Cormorant'; src: url('${font('@fontsource/cormorant-garamond/files/cormorant-garamond-latin-500-italic.woff2')}') format('woff2'); font-style: italic; }
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; }
  .sheet { width: 210mm; height: 297mm; display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }
  .card { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2.2mm;
    padding: 8mm 9mm; text-align: center; color: #241713; background: #efe2c2; font-family: 'Cormorant', Georgia, serif;
    border: 0.3mm dashed #9c8a6a; }
  .card::before { content: ''; position: absolute; inset: 4mm; border: 0.5mm double #241713; outline: 0.2mm solid rgba(36,23,19,.4); outline-offset: 1mm; pointer-events: none; }
  .rail { margin: 0; font-family: 'Cinzel', serif; font-size: 2.6mm; letter-spacing: .14em; text-transform: uppercase; color: #4b3328; }
  h1 { margin: 0; font-family: 'Cinzel', serif; font-weight: 800; font-size: 8.4mm; line-height: 1; border-top: .3mm solid #241713; border-bottom: .6mm double #241713; padding: 1.5mm 0; width: 100%; }
  .lead { margin: 0; font-size: 5mm; font-weight: 600; color: #740f20; }
  .qr { width: 44mm; height: 44mm; background: #fff; padding: 2mm; border: .3mm solid #241713; }
  .qr svg { display: block; width: 100%; height: 100%; }
  .hint { margin: 0; font-style: italic; font-size: 3.4mm; color: #4b3328; }
  .magic { margin: 0; font-size: 4.4mm; }
  .magic strong { font-family: 'Cinzel', serif; font-size: 4.6mm; color: #740f20; letter-spacing: .04em; }
  .blank { display: inline-block; width: 38mm; border-bottom: .3mm solid #241713; }
  .small { margin: 0; max-width: 78mm; font-size: 3.2mm; line-height: 1.25; color: #4b3328; }
  .url { margin: 0; font-family: 'Cinzel', serif; font-size: 2.6mm; letter-spacing: .06em; color: #4b3328; }
</style>
</head>
<body>
  <main class="sheet">${card.repeat(4)}</main>
</body>
</html>
`;
}

function argValue(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : null;
}

export async function main(args: string[]): Promise<void> {
  if (!siteMeta.url) throw new Error('siteMeta.url (src/content/site.ts) ainda não tem o domínio do convite.');
  const pageUrl = `${siteMeta.url.replace(/\/+$/, '')}${profetaConfig.path}`;
  const password = (argValue(args, '--senha') ?? process.env.PROFETA_SENHA ?? '').trim() || null;
  const whatsapp = rsvpConfig.whatsappNumber ? formatWhatsappNumber(rsvpConfig.whatsappNumber) : null;
  const qrSvg = await QRCode.toString(pageUrl, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#241713', light: '#ffffff' } });

  mkdirSync(OUT, { recursive: true });
  const htmlPath = join(OUT, 'cartoes-profeta.html');
  writeFileSync(htmlPath, cardHtml(pageUrl, qrSvg, password, whatsapp));

  const chrome =
    process.env.CHROME_PATH ??
    ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => existsSync(p));
  const pdfPath = join(OUT, 'cartoes-profeta.pdf');
  if (chrome) {
    const browser = await chromium.launch({ executablePath: chrome });
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(resolve(htmlPath)).href, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      await page.pdf({ path: pdfPath, printBackground: true, preferCSSPageSize: true });
    } finally {
      await browser.close();
    }
  }
  console.log(`Cartões do Profeta (QR → ${pageUrl}):`);
  console.log(`  ${htmlPath}`);
  console.log(chrome ? `  ${pdfPath}  (A4 com 4 cartões; imprima em papel encorpado e corte nas linhas)` : '  (PDF não gerado: Chrome não encontrado; defina CHROME_PATH)');
  if (!password) console.log('  Sem --senha: a palavra mágica fica numa linha para escrever à mão.');
}
