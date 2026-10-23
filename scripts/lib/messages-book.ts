/**
 * Livro de Recados: os recados dos convidados para a Sofia, recolhidos pela
 * Professora Aifos, num pergaminho para imprimir ou guardar.
 *
 *   npm run messages:book            # banco real (.env.local), grava em recados/
 *   npm run messages:book -- --demo  # convidados fictícios (PGlite), grava em test-results/
 *
 * Inclui, numa seção própria, as mensagens que vieram junto com presentes da lista
 * (só de pagamentos confirmados pelo Asaas; sem valores).
 *
 * Gera `recados.json` (base para exibir os recados no site ou na Penseira),
 * `recados-presentes.json`,
 * `livro-de-recados.html` (fontes embutidas: abre em qualquer navegador) e
 * `livro-de-recados.pdf` (Chrome local, como no e2e). A pasta recados/ não é
 * versionada: são dados pessoais.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright-core';
import type { GuestMessageEntry } from '../../supabase/functions/_shared/whatsapp/report.ts';
import { event } from '../../src/content/event.ts';
import { formatDateLong } from '../../src/lib/date.ts';
import { createDevDatabase, pgliteRpc, resetDevData } from './pglite-db.ts';

/** Mensagem que veio junto com um presente pago (public.bot_gift_messages). */
export interface GiftMessageEntry {
  gift_name: string;
  signature: string | null;
  anonymous: boolean;
  body: string;
  paid_at: string | null;
}

export interface BookOptions {
  celebrant: string;
  /** "20 de fevereiro de 2027" */
  dateLabel: string;
  /** @font-face prontos (embutidos); vazio nos testes. */
  fontFaces?: string;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Parágrafos do recado (linha em branco separa; quebra simples vira <br>). */
const paragraphs = (body: string) =>
  body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');

export function renderBook(entries: GuestMessageEntry[], options: BookOptions, giftEntries: GiftMessageEntry[] = []): string {
  const cards = entries
    .map(
      (m) => `
    <article class="note">
      <div class="note__body">${paragraphs(m.body)}</div>
      <p class="note__signature">${escapeHtml(m.signature ?? m.full_name)}</p>
      <p class="note__meta">${escapeHtml(m.signature && m.signature !== m.full_name ? `${m.full_name} · ${m.household}` : m.household)}</p>
    </article>`,
    )
    .join('');

  const giftCards = giftEntries
    .map(
      (m) => `
    <article class="note">
      <div class="note__body">${paragraphs(m.body)}</div>
      <p class="note__signature">${escapeHtml(m.anonymous || !m.signature ? 'Em segredo' : m.signature)}</p>
      <p class="note__meta">junto com o presente “${escapeHtml(m.gift_name)}”</p>
    </article>`,
    )
    .join('');
  const giftSection = giftCards
    ? `
  <section class="gifts">
    <h2 class="section-title">Recados que vieram com presentes</h2>${giftCards}
  </section>`
    : '';

  const total = entries.length + giftEntries.length;
  const count = total === 1 ? '1 recado' : `${total} recados`;
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Livro de Recados · ${escapeHtml(options.celebrant)}</title>
  <style>
    ${options.fontFaces ?? ''}
    :root {
      --parchment: #efe0bd;
      --ink: #291a17;
      --ink-soft: #4b3328;
      --wine: #740f20;
      --gold: #9e7a33;
      --display: 'Cinzel', Georgia, serif;
      --serif: 'Cormorant Garamond', Georgia, serif;
      --script: 'Pinyon Script', 'Cormorant Garamond', cursive;
    }
    @page { size: A4; margin: 18mm 16mm; }
    * { box-sizing: border-box; }
    html { background: var(--parchment); }
    body {
      margin: 0 auto;
      max-width: 46rem;
      padding: 2rem 1rem 4rem;
      color: var(--ink);
      background: var(--parchment);
      font-family: var(--serif);
      font-size: 1.2rem;
      line-height: 1.55;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .cover {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 80vh;
      text-align: center;
      break-after: page;
    }
    .cover__kicker { margin: 0; font-family: var(--display); letter-spacing: 0.35em; text-transform: uppercase; font-size: 0.85rem; color: var(--gold); }
    .cover__title { margin: 0.6rem 0 0.4rem; font-family: var(--display); font-size: 2.6rem; font-weight: 600; color: var(--wine); }
    .cover__for { margin: 0; font-family: var(--script); font-size: 2.4rem; color: var(--ink); }
    .cover__date { margin: 1.2rem 0 0; font-style: italic; color: var(--ink-soft); }
    .cover__rule { width: 10rem; height: 1px; margin: 1.6rem auto; background: linear-gradient(90deg, transparent, var(--gold), transparent); }
    .note {
      margin: 0 0 1.6rem;
      padding: 1.6rem 1.8rem 1.2rem;
      border: 1px solid rgba(158, 122, 51, 0.5);
      border-radius: 4px;
      background: rgba(255, 248, 230, 0.45);
      break-inside: avoid;
    }
    .note__body p { margin: 0 0 0.7rem; font-style: italic; }
    .note__signature { margin: 0.4rem 0 0; text-align: right; font-family: var(--script); font-size: 1.9rem; line-height: 1.2; color: var(--wine); }
    .note__meta { margin: 0; text-align: right; font-size: 0.9rem; color: var(--ink-soft); }
    .empty { text-align: center; font-style: italic; color: var(--ink-soft); }
    .gifts { break-before: page; }
    .section-title { margin: 0 0 1.6rem; text-align: center; font-family: var(--display); font-size: 1.1rem; font-weight: 600; letter-spacing: 0.2em; text-transform: uppercase; color: var(--wine); }
    /* No papel: fundo branco (o Chrome não pinta a margem da página, e poupa tinta). */
    @media print {
      html, body { background: #fff; }
      body { max-width: none; padding: 0; }
      .note { background: #fdf8ec; }
    }
  </style>
</head>
<body>
  <section class="cover">
    <p class="cover__kicker">Livro de Recados</p>
    <h1 class="cover__title">${escapeHtml(options.celebrant)}</h1>
    <p class="cover__for">com carinho, dos seus convidados</p>
    <div class="cover__rule"></div>
    <p class="cover__date">15 anos · ${escapeHtml(options.dateLabel)} · ${count}</p>
  </section>
  ${cards || (giftCards ? '' : '<p class="empty">Ainda não há recados.</p>')}${giftSection}
</body>
</html>
`;
}

/** @font-face com as fontes do site embutidas (o HTML funciona sozinho, fora do projeto). */
function embeddedFonts(): string {
  const font = (family: string, file: string, style = 'normal', weight = '400') => {
    const data = readFileSync(resolve('node_modules', file)).toString('base64');
    return `@font-face { font-family: '${family}'; font-style: ${style}; font-weight: ${weight}; src: url(data:font/woff2;base64,${data}) format('woff2'); }`;
  };
  return [
    font('Cinzel', '@fontsource-variable/cinzel/files/cinzel-latin-wght-normal.woff2', 'normal', '400 900'),
    font('Cormorant Garamond', '@fontsource/cormorant-garamond/files/cormorant-garamond-latin-500-normal.woff2', 'normal', '500'),
    font('Cormorant Garamond', '@fontsource/cormorant-garamond/files/cormorant-garamond-latin-500-italic.woff2', 'italic', '500'),
    font('Pinyon Script', '@fontsource/pinyon-script/files/pinyon-script-latin-400-normal.woff2'),
  ].join('\n    ');
}

// Recados FICTÍCIOS do modo --demo (os convidados de scripts/lib/pglite-db.ts).
const DEMO_MESSAGES: [phone: string, body: string, signature: string | null, source: 'text' | 'audio'][] = [
  ['5531988887777', 'Sofia, você é a estrela da nossa família.\n\nQue os seus 15 anos sejam tão mágicos quanto você!', 'Tio Carlos e Marta', 'text'],
  ['5531966665555', 'Prima, que noite incrível vai ser! Te amo muito.', null, 'audio'],
  ['5521999990000', 'Que essa nova fase seja cheia de coragem, como uma verdadeira grifinória.', null, 'text'],
];

// Mensagens FICTÍCIAS que vieram com presentes (pedidos já pagos), também do --demo.
const DEMO_GIFT_MESSAGES: [gift: string, body: string, signature: string | null][] = [
  ['A viagem dos sonhos', 'Para a sua primeira grande aventura: que venham muitas outras!', 'Padrinho Rafael'],
  ['Uma varinha nova', 'Um presentinho em segredo para a bruxinha mais querida.', null],
];

interface BookEntries {
  messages: GuestMessageEntry[];
  gifts: GiftMessageEntry[];
}

async function loadEntries(demo: boolean): Promise<BookEntries> {
  if (demo) {
    const db = await createDevDatabase();
    try {
      const rpc = pgliteRpc(db);
      await resetDevData(db, rpc);
      for (const [phone, body, signature, source] of DEMO_MESSAGES) {
        await rpc('bot_save_guest_message', { p_phone: phone, p_body: body, p_signature: signature, p_source: source, p_wa_message_id: null });
      }
      for (const [gift, body, signature] of DEMO_GIFT_MESSAGES) {
        await rpc('bot_create_gift_order', {
          p_gift_id: 'demo',
          p_gift_name: gift,
          p_kind: 'quota',
          p_payment_method: 'pix',
          p_base_cents: 10_000,
          p_charged_cents: 10_400,
          p_message: body,
          p_signature: signature,
          p_anonymous: signature === null,
          p_ip_hash: null,
        });
      }
      await db.exec(`update public.gift_orders set status = 'paid', paid_at = now()`);
      return {
        messages: (await rpc('bot_guest_messages', {})) as GuestMessageEntry[],
        gifts: (await rpc('bot_gift_messages', {})) as GiftMessageEntry[],
      };
    } finally {
      await db.close();
    }
  }

  if (existsSync('.env.local')) process.loadEnvFile('.env.local');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Defina SUPABASE_URL e SUPABASE_SECRET_KEY em .env.local (veja .env.example).');
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await supabase.rpc('bot_guest_messages', {});
  if (error) throw new Error(`Erro do Supabase: ${error.message}`);
  const gifts = await supabase.rpc('bot_gift_messages', {});
  if (gifts.error) throw new Error(`Erro do Supabase: ${gifts.error.message}`);
  return { messages: data as GuestMessageEntry[], gifts: gifts.data as GiftMessageEntry[] };
}

async function writePdf(htmlPath: string, pdfPath: string): Promise<boolean> {
  const chrome =
    process.env.CHROME_PATH ??
    ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(
      (p) => existsSync(p),
    );
  if (!chrome) return false;
  const browser = await chromium.launch({ executablePath: chrome });
  try {
    const page = await browser.newPage();
    await page.goto(`file://${resolve(htmlPath).replace(/\\/g, '/')}`, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, preferCSSPageSize: true });
    return true;
  } finally {
    await browser.close();
  }
}

export async function main(argv: string[]): Promise<void> {
  const demo = argv.includes('--demo');
  const outDir = demo ? 'test-results' : 'recados';
  const prefix = demo ? 'livro-de-recados-demo' : 'livro-de-recados';

  const { messages: entries, gifts } = await loadEntries(demo);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, demo ? 'recados-demo.json' : 'recados.json'), `${JSON.stringify(entries, null, 2)}\n`);
  writeFileSync(join(outDir, demo ? 'recados-presentes-demo.json' : 'recados-presentes.json'), `${JSON.stringify(gifts, null, 2)}\n`);

  const html = renderBook(
    entries,
    {
      celebrant: event.celebrant,
      dateLabel: formatDateLong(event.date),
      fontFaces: embeddedFonts(),
    },
    gifts,
  );
  const htmlPath = join(outDir, `${prefix}.html`);
  writeFileSync(htmlPath, html);
  const pdfPath = join(outDir, `${prefix}.pdf`);
  const pdf = await writePdf(htmlPath, pdfPath);

  console.log(`${entries.length} recado(s) e ${gifts.length} mensagem(ns) com presente${demo ? ' (fictícios)' : ''}.`);
  console.log(`  ${htmlPath}`);
  console.log(pdf ? `  ${pdfPath}` : '  (PDF não gerado: Chrome não encontrado; defina CHROME_PATH)');
}
