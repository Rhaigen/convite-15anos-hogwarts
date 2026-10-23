// Testes de ponta a ponta no build de produção, com o Chrome instalado na máquina.
//   npm run test:e2e            (CHROME_PATH=... para outro navegador Chromium)
//
// Gera um build de teste (dist-e2e) e o serve com `vite preview`. A confirmação de presença
// é um link para o WhatsApp da Professora Aifos. De fora, só as funções públicas: as cartas do
// Salão Principal e a lista de presentes (progresso e link de pagamento), simuladas aqui
// (page.route) com os dados fictícios de scripts/fixtures; o checkout do Asaas também.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const CHROME =
  process.env.CHROME_PATH ??
  ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(
    (p) => fs.existsSync(p),
  );
if (!CHROME) {
  console.error('Chrome não encontrado. Defina CHROME_PATH.');
  process.exit(1);
}

const PORT = 4317;
const BASE = `http://localhost:${PORT}/`;
const OUT = 'dist-e2e';
const SHOTS = path.resolve('test-results');
fs.mkdirSync(SHOTS, { recursive: true });
const vite = path.resolve('node_modules/vite/bin/vite.js');

// Endereço das cartas no build de teste: respondido pelo próprio teste, nunca pela rede.
const HALL_URL = 'https://salao.test/site-messages';
const HALL_DEMO = JSON.parse(fs.readFileSync('scripts/fixtures/salao-demo.json', 'utf8')).letters;
const hallResponse = (state) => {
  if (state === 'erro') return { status: 503, body: '{"error":"unavailable"}' };
  const sealed = state !== 'aberto';
  const letters = state === 'vazio' ? [] : HALL_DEMO.map((l) => (sealed ? { id: l.id, from: l.from } : l));
  return { status: 200, body: JSON.stringify({ sealed, unsealAt: '2027-02-20T03:00:00+00:00', letters }) };
};

// Lista de presentes no build de teste: a lista fictícia de scripts/fixtures e as funções
// (progresso das vaquinhas e link de pagamento) respondidas pelo teste; o "Asaas" também.
const GIFTS_ORIGIN = 'https://presentes.test';
const GIFT_CHECKOUT_URL = `${GIFTS_ORIGIN}/gift-checkout`;
const GIFT_PROGRESS_URL = `${GIFTS_ORIGIN}/site-gifts`;
const ASAAS_CHECKOUT = 'https://sandbox.asaas.com/checkoutSession/show?id=chk_e2e';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };

const env = {
  ...process.env,
  VITE_MESSAGES_URL: HALL_URL,
  VITE_E2E_GIFTS_DEMO: 'true',
  VITE_GIFT_CHECKOUT_URL: GIFT_CHECKOUT_URL,
  VITE_GIFT_PROGRESS_URL: GIFT_PROGRESS_URL,
};
console.log('• Build de teste…');
const build = spawnSync(process.execPath, [vite, 'build', '--outDir', OUT, '--emptyOutDir', '--logLevel', 'error'], { env, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

const server = spawn(process.execPath, [vite, 'preview', '--outDir', OUT, '--port', String(PORT), '--strictPort'], { env, stdio: 'pipe' });
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('preview não iniciou')), 20000);
  server.stdout.on('data', (d) => d.toString().includes(String(PORT)) && (clearTimeout(timer), resolve()));
});

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({ executablePath: CHROME });

async function newPage({ hall = 'selado', checkout = 'ok', ...options } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  await context.route(`${HALL_URL}**`, (route) => {
    const { status, body } = hallResponse(hall);
    return route.fulfill({ status, body, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  await context.route(`${GIFT_PROGRESS_URL}**`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ gifts: [{ id: 'viagem', raisedCents: 312_000, goalCents: 500_000 }] }) }),
  );
  // Pedidos de pagamento recebidos pela "função" (o corpo, para conferir o que o site manda).
  const checkouts = [];
  await context.route(`${GIFT_CHECKOUT_URL}**`, (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    checkouts.push(req.postDataJSON());
    if (checkout === 'busy') return route.fulfill({ status: 429, contentType: 'application/json', headers: CORS, body: '{"error":"busy"}' });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ url: ASAAS_CHECKOUT }) });
  });
  await context.route('https://sandbox.asaas.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Asaas (teste)</title><p>Checkout de teste</p>' }),
  );
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return { context, page, errors, checkouts };
}

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const letterVisible = (page) =>
  page.evaluate(() => {
    const t = document.getElementById('letter-title');
    return !!t && !document.querySelector('.opening') && getComputedStyle(t).opacity === '1';
  });

try {
  // 1. Abertura por clique (desktop)
  {
    const { context, page, errors } = await newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    check('Cena inicial exibe o envelope como botão acessível', await page.getByRole('button', { name: 'Abrir a carta de convite' }).isVisible());
    check('Abertura avisa para ligar o som', await page.locator('.opening__sound', { hasText: /Ligue o som/ }).isVisible());
    check('Conteúdo atrás do envelope fica inerte', await page.evaluate(() => document.getElementById('conteudo')?.inert === true));
    await page.click('.opening__envelope-btn');
    await page.waitForTimeout(400);
    check('Toque gera resposta imediata (estado "abrindo")', (await page.getAttribute('.opening', 'data-state')) === 'opening');
    await page.waitForSelector('.opening', { state: 'detached', timeout: 8000 });
    await page.waitForTimeout(3500);
    check('Carta legível após a sequência', await letterVisible(page));
    check('Rolagem liberada após abrir', await page.evaluate(() => !document.documentElement.classList.contains('is-locked')));
    await page.screenshot({ path: path.join(SHOTS, 'desktop-carta.png') });

    // Navegação pelo índice
    await page.getByRole('button', { name: 'Abrir índice de capítulos' }).click();
    check('Índice de capítulos abre como diálogo', await page.locator('dialog.chapter-menu[open]').isVisible());
    await page.locator('dialog.chapter-menu a[href="#presenca"]').click();
    await page.waitForTimeout(2500);
    const rsvpTop = await page.evaluate(() => document.getElementById('presenca').getBoundingClientRect().top);
    check('Link do índice leva à confirmação de presença', Math.abs(rsvpTop) < 120, `top=${Math.round(rsvpTop)}`);

    // Percorre a página inteira
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < height; y += 600) {
      await page.evaluate((v) => window.scrollTo(0, v), y);
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(2500);
    check('Botões do encerramento visíveis', await page.evaluate(() => [...document.querySelectorAll('.closing__actions a')].every((a) => getComputedStyle(a).opacity === '1')));
    check('Sem overflow horizontal (desktop)', (await overflow(page)) <= 0);
    check('Sem erros no console (desktop)', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  // 2. Teclado
  {
    const { context, page, errors } = await newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(() => document.activeElement?.classList.contains('opening__envelope-btn'))) break;
    }
    check('Envelope alcançável por Tab', await page.evaluate(() => document.activeElement?.classList.contains('opening__envelope-btn')));
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape'); // pular animação
    await page.waitForTimeout(600);
    check('Esc pula a animação e revela a carta', await letterVisible(page));
    check('Foco movido para o título da carta', await page.evaluate(() => document.activeElement?.id === 'letter-title'));
    check('Sem erros no console (teclado)', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  // 3. Galeria: torre espiral de retratos e retrato ampliado
  {
    const { context, page, errors } = await newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.click('.opening__envelope-btn');
    await page.waitForSelector('.opening', { state: 'detached', timeout: 8000 });
    await page.waitForSelector('.tower.is-tower', { timeout: 8000 });
    const n = await page.locator('.tower-frame').count();
    check('Galeria: torre montada', n > 0, `${n} quadros`);

    const front = () =>
      page.evaluate(() => [...document.querySelectorAll('.tower-frame')].findIndex((el) => el.classList.contains('is-front')));
    // Posição da página que traz o quadro `i` para a frente.
    const scrollToFrame = async (i) => {
      await page.evaluate(
        ([i, n]) => {
          const tower = document.querySelector('.tower');
          const top = tower.getBoundingClientRect().top + window.scrollY;
          const range = tower.offsetHeight - window.innerHeight;
          window.scrollTo(0, top + (n > 1 ? (range * i) / (n - 1) : 0));
        },
        [i, n],
      );
      await page.waitForTimeout(1500);
    };
    const counter = () => page.locator('.lightbox__counter').textContent();
    const focusedFrame = () => page.evaluate(() => [...document.querySelectorAll('.tower-frame__front')].indexOf(document.activeElement));

    await scrollToFrame(0);
    const first = await front();
    const mid = Math.floor((n - 1) / 2);
    await scrollToFrame(mid);
    const middle = await front();
    check('Galeria: rolar gira a torre e muda o quadro da frente', first === 0 && middle === mid, `${first} → ${middle}`);
    await page.screenshot({ path: path.join(SHOTS, 'galeria-torre.png') });
    await scrollToFrame(0);
    check('Galeria: rolar de volta restaura o primeiro quadro', (await front()) === 0);

    if (n > 2) {
      const side = await page.locator('.tower-frame').nth(1).boundingBox();
      await page.mouse.click(side.x + side.width / 2, side.y + side.height / 2);
      await page.waitForTimeout(2200);
      check('Galeria: clique num quadro lateral o traz para a frente', (await front()) === 1 && (await page.locator('dialog.lightbox[open]').count()) === 0);

      const box = await page.locator('.tower-frame.is-front').boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(700);
      check('Galeria: clique no quadro da frente amplia a foto', await page.locator('dialog.lightbox[open]').isVisible());
      check('Galeria: contador do retrato ampliado', (await counter())?.trim() === `2 de ${n}`, await counter());
      check('Galeria: rolagem da página travada com a foto ampliada', await page.evaluate(() => getComputedStyle(document.documentElement).overflow === 'hidden'));
      await page.screenshot({ path: path.join(SHOTS, 'galeria-ampliada.png') });
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(400);
      check('Galeria: seta → mostra a próxima foto', (await counter())?.trim() === `3 de ${n}`, await counter());
      await page.keyboard.press('Escape');
      await page.waitForTimeout(2500);
      check(
        'Galeria: Esc fecha, devolve o foco e gira a torre até a última foto vista',
        (await page.locator('dialog.lightbox[open]').count()) === 0 && (await focusedFrame()) === 2 && (await front()) === 2,
        `foco ${await focusedFrame()}, frente ${await front()}`,
      );
      if (n > 3) {
        await page.keyboard.press('Tab');
        await page.waitForTimeout(2200);
        check('Galeria: Tab leva o próximo quadro à frente', (await focusedFrame()) === 3 && (await front()) === 3, `foco ${await focusedFrame()}, frente ${await front()}`);
      }
    }
    check('Sem erros no console (galeria)', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  // 4. Movimento reduzido
  {
    const { context, page, errors } = await newPage({ reducedMotion: 'reduce' });
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.click('.opening__envelope-btn');
    await page.waitForTimeout(900);
    check('Movimento reduzido: carta aberta sem a sequência 3D', await letterVisible(page));
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < height; y += 900) {
      await page.evaluate((v) => window.scrollTo(0, v), y);
      await page.waitForTimeout(60);
    }
    const hidden = await page.evaluate(() =>
      ['.house__letter', '.scroll__para', '.map__panel', '.tower-frame__front', '.countdown__unit', '.rsvp-card', '.gifts__rolled', '.gifts__open', '.hall-letter__env', '.hall__count', '.hall__cta', '.closing__actions a', '.chapter-heading__title']
        .flatMap((s) => [...document.querySelectorAll(s)])
        .filter((el) => getComputedStyle(el).opacity !== '1').length,
    );
    check('Movimento reduzido: todo o conteúdo visível sem depender de animação', hidden === 0, `${hidden} ocultos`);
    check('Movimento reduzido: sem pin (página sem espaçadores)', await page.evaluate(() => document.querySelectorAll('.pin-spacer').length === 0));
    check('Movimento reduzido: galeria em coluna estática (sem torre 3D)', await page.evaluate(() => !!document.querySelector('.tower') && !document.querySelector('.is-tower')));
    const frame = page.locator('.tower-frame__front').nth(1);
    await frame.scrollIntoViewIfNeeded();
    await frame.click();
    await page.waitForTimeout(300);
    const opened = await page.locator('dialog.lightbox[open]').isVisible();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check(
      'Movimento reduzido: tocar no quadro amplia a foto e Esc devolve o foco',
      opened && (await page.evaluate(() => document.activeElement?.classList.contains('tower-frame__front'))),
    );
    check('Sem erros no console (reduzido)', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  // 5. Celular (retrato e paisagem)
  for (const vp of [
    { width: 390, height: 844, label: 'celular retrato' },
    { width: 844, height: 390, label: 'celular paisagem' },
    { width: 320, height: 640, label: 'celular pequeno' },
  ]) {
    const { context, page, errors } = await newPage({ viewport: { width: vp.width, height: vp.height }, isMobile: true, hasTouch: true });
    await page.goto(BASE, { waitUntil: 'networkidle' });
    const box = await page.locator('.opening__envelope-btn').boundingBox();
    check(`${vp.label}: envelope inteiro na tela`, !!box && box.y >= 0 && box.y + box.height <= vp.height && box.x >= 0 && box.x + box.width <= vp.width);
    const sound = await page.locator('.opening__sound').boundingBox();
    check(`${vp.label}: aviso de som inteiro na tela`, !!sound && sound.y >= 0 && sound.y + sound.height <= vp.height && sound.x >= 0 && sound.x + sound.width <= vp.width);
    await page.screenshot({ path: path.join(SHOTS, `${vp.label.replace(/ /g, '-')}-envelope.png`) });
    await page.tap('.opening__envelope-btn');
    await page.waitForSelector('.opening', { state: 'detached', timeout: 8000 });
    await page.waitForTimeout(800);
    check(`${vp.label}: carta aberta por toque`, await page.evaluate(() => !!document.getElementById('letter-title')));
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < height; y += 500) {
      await page.evaluate((v) => window.scrollTo(0, v), y);
      await page.waitForTimeout(40);
    }
    check(`${vp.label}: sem overflow horizontal`, (await overflow(page)) <= 0);
    check(`${vp.label}: sem erros no console`, errors.length === 0, errors.join(' | '));
    await context.close();
  }

  // 6. Link direto
  {
    const { context, page } = await newPage();
    await page.goto(`${BASE}#presenca`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    const top = await page.evaluate(() => document.getElementById('presenca').getBoundingClientRect().top);
    check('Link direto /#presenca pula o envelope e mostra a confirmação', !(await page.locator('.opening').count()) && Math.abs(top) < 150);
    await context.close();
  }

  // 7. Confirmação pela Rede de Flu (link para o WhatsApp da Professora Aifos)
  {
    const { context, page, errors } = await newPage();
    const external = [];
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (!['localhost', '127.0.0.1', new URL(HALL_URL).hostname, new URL(GIFTS_ORIGIN).hostname].includes(u.hostname) && !u.protocol.startsWith('data')) {
        external.push(u.hostname);
      }
    });
    await page.goto(`${BASE}#presenca`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2200);
    const card = page.locator('#presenca .rsvp-card');
    check('Rede de Flu: cartão com o título do Pó de Flu', await card.getByRole('heading', { name: /Pó de Flu/ }).isVisible());
    check('Rede de Flu: nenhum formulário ou campo no capítulo', (await page.locator('#presenca form, #presenca input, #presenca textarea').count()) === 0);
    const link = card.getByRole('link', { name: /Falar com a Professora Aifos/ });
    const href = (await link.getAttribute('href')) ?? '';
    const url = new URL(href);
    check(
      'Rede de Flu: botão abre a conversa da Aifos no wa.me com a mensagem inicial',
      url.origin === 'https://wa.me' && url.pathname === '/5511999999999' && /Professora Aifos/.test(url.searchParams.get('text') ?? ''),
      href,
    );
    check(
      'Rede de Flu: link em nova aba, sem acesso à janela de origem',
      (await link.getAttribute('target')) === '_blank' && /noopener/.test((await link.getAttribute('rel')) ?? ''),
    );
    check('Rede de Flu: aviso de nova aba para leitores de tela', /nova aba/.test((await link.evaluate((a) => document.getElementById(a.getAttribute('aria-describedby') ?? '')?.textContent)) ?? ''));
    check('Rede de Flu: sem o bloco do recado para a Sofia', !/recado/i.test((await card.textContent()) ?? ''));
    check('Rede de Flu: número visível para salvar o contato', (await card.textContent())?.includes('+55 11 99999-9999'));
    check('Rede de Flu: deixa claro que a Aifos é uma inteligência artificial', /inteligência artificial/.test((await card.textContent()) ?? ''));
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const flames = await page.evaluate(() => {
      const flame = document.querySelector('.floo-flames__flame');
      return {
        state: flame ? getComputedStyle(flame).animationPlayState : 'sem chama',
        idle: !!document.querySelector('.floo.is-idle'),
        motion: document.documentElement.dataset.motion,
      };
    });
    check('Rede de Flu: chamas tremulando com o cartão na tela', flames.state === 'running' && !flames.idle, JSON.stringify(flames));
    await card.screenshot({ path: path.join(SHOTS, 'rede-de-flu.png') });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
    check('Rede de Flu: chamas pausadas com o cartão fora da tela', await page.evaluate(() => !!document.querySelector('.floo.is-idle')));
    const csp = (await page.getAttribute('meta[http-equiv="Content-Security-Policy"]', 'content')) ?? '';
    check(
      'CSP: connect-src só da própria origem, das cartas do Salão e das funções da lista de presentes',
      csp.includes(`connect-src 'self' ${new URL(HALL_URL).origin} ${GIFTS_ORIGIN};`),
      csp.match(/connect-src[^;]*/)?.[0],
    );
    check('Nenhuma requisição a outros domínios (além das funções públicas)', external.length === 0, [...new Set(external)].join(', '));
    const bundle = fs
      .readdirSync(path.join(OUT, 'assets'))
      .filter((f) => f.endsWith('.js'))
      .some((f) => /@supabase\/|supabase-js|createClient\(|apikey|sb_(publishable|secret)_/i.test(fs.readFileSync(path.join(OUT, 'assets', f), 'utf8')));
    check('Bundle sem o cliente do Supabase nem chaves', !bundle);
    check('Sem erros no console (Rede de Flu)', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  // 8. Rede de Flu no celular, com movimento reduzido
  {
    const { context, page, errors } = await newPage({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    await page.goto(`${BASE}#presenca`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    const button = page.locator('.floo__button');
    await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox();
    check('Celular: botão da Aifos inteiro na largura da tela', !!box && box.x >= 0 && box.x + box.width <= 360 && box.height >= 44, box ? `${Math.round(box.x)}..${Math.round(box.x + box.width)}` : '');
    const hidden = await page.evaluate(() =>
      [...document.querySelectorAll('.rsvp-card, .floo__flames, .floo__reveal')].filter((el) => getComputedStyle(el).opacity !== '1').length,
    );
    check('Celular reduzido: cartão inteiro visível sem animação', hidden === 0, `${hidden} ocultos`);
    check('Celular: sem overflow horizontal no capítulo', (await overflow(page)) <= 0);
    await page.locator('#presenca .rsvp-card').screenshot({ path: path.join(SHOTS, 'rede-de-flu-celular.png') });
    check('Sem erros no console (Rede de Flu, celular)', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  // 10. O Salão Principal: cartas seladas até a festa
  {
    const { context, page, errors } = await newPage();
    await page.goto(`${BASE}#salao`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.hall-letter', { timeout: 8000 });
    await page.waitForTimeout(2500);
    const n = await page.locator('.hall-letter').count();
    check('Salão selado: todas as cartas penduradas', n === HALL_DEMO.length, `${n} cartas`);
    check(
      'Salão selado: contagem e data dos selos',
      /14 cartas aguardam/i.test(await page.locator('.hall__count').innerText()) && /20 de fevereiro de 2027/.test(await page.locator('.hall__note').innerText()),
    );
    check('Salão selado: nenhum texto de carta na página', !(await page.content()).includes('nossa estrela'));
    const letter = page.locator('.hall-letter').nth(1);
    check('Salão selado: carta anuncia que está selada', /selada até 20 de fevereiro de 2027/.test((await letter.getAttribute('aria-label')) ?? ''));
    await letter.click();
    await page.waitForTimeout(400);
    check(
      'Salão selado: tocar avisa e não abre',
      /selada pela magia/.test(await page.locator('.hall__notice').innerText()) && !(await page.locator('dialog.hall-dialog[open]').count()),
    );
    await page.screenshot({ path: path.join(SHOTS, 'salao-selado.png') });
    check('Salão: sem overflow horizontal (desktop)', (await overflow(page)) <= 0);
    check('Sem erros no console (Salão selado)', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  // 11. O Salão Principal depois da festa: abrir, navegar, fechar
  {
    const { context, page, errors } = await newPage({ hall: 'aberto' });
    await page.goto(`${BASE}#salao`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.hall-letter', { timeout: 8000 });
    await page.waitForTimeout(2500);
    await page.locator('.hall-letter').first().click();
    await page.waitForTimeout(3600);
    check('Salão aberto: a carta abre num diálogo', await page.locator('dialog.hall-dialog[open]').isVisible());
    check(
      'Salão aberto: texto e assinatura visíveis',
      /nossa estrela/.test(await page.locator('.hall-sheet').innerText()) && (await page.locator('.hall-sheet__from').innerText()) === 'Tio Carlos e Marta',
    );
    check('Salão aberto: foco dentro da carta', await page.evaluate(() => !!document.activeElement?.closest('dialog.hall-dialog')));
    await page.screenshot({ path: path.join(SHOTS, 'salao-carta.png') });
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(600);
    check(
      'Salão aberto: seta → leva à próxima carta',
      /^2 de 14$/i.test((await page.locator('.hall-dialog__counter').innerText()).trim()) && /Vovó Lúcia/.test(await page.locator('.hall-sheet__from').innerText()),
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(700);
    check('Salão aberto: Esc fecha a carta', !(await page.locator('dialog.hall-dialog[open]').count()));
    check('Salão aberto: foco volta para o Salão', await page.evaluate(() => !!document.activeElement?.closest('.hall-letter')));
    check('Salão aberto: cartas lidas ficam com o selo partido', (await page.locator('.hall-letter.is-read').count()) === 2);
    check('Sem erros no console (Salão aberto)', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  // 12. O Salão vazio, com a função fora do ar, e no celular com movimento reduzido
  {
    const empty = await newPage({ hall: 'vazio' });
    await empty.page.goto(`${BASE}#salao`, { waitUntil: 'networkidle' });
    await empty.page.waitForTimeout(1500);
    const cta = empty.page.locator('.hall__cta a');
    check(
      'Salão vazio: convite para a primeira carta, com o link da Aifos',
      /primeira/i.test(await empty.page.locator('.hall__count').innerText()) &&
        ((await cta.getAttribute('href')) ?? '').startsWith('https://wa.me/5511999999999?text=') &&
        (await empty.page.locator('.hall-letter').count()) === 0,
    );
    await empty.context.close();

    const down = await newPage({ hall: 'erro' });
    await down.page.goto(`${BASE}#salao`, { waitUntil: 'networkidle' });
    await down.page.waitForTimeout(1500);
    check(
      'Salão sem a função: sem cartas inventadas, só o convite para escrever',
      (await down.page.locator('.hall-letter').count()) === 0 && (await down.page.locator('.hall__cta a').isVisible()),
    );
    await down.context.close();

    const { context, page, errors } = await newPage({
      hall: 'aberto',
      viewport: { width: 360, height: 740 },
      isMobile: true,
      hasTouch: true,
      reducedMotion: 'reduce',
    });
    await page.goto(`${BASE}#salao`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.hall-letter', { timeout: 8000 });
    await page.waitForTimeout(800);
    const hidden = await page.evaluate(() => [...document.querySelectorAll('.hall-letter__env')].filter((el) => getComputedStyle(el).opacity !== '1').length);
    check('Salão no celular reduzido: cartas visíveis sem animação', hidden === 0, `${hidden} ocultas`);
    const box = await page.locator('.hall-letter').first().boundingBox();
    check('Salão no celular: carta inteira na tela e fácil de tocar', !!box && box.x >= 0 && box.x + box.width <= 360 && box.height >= 44);
    await page.locator('.hall-letter').first().tap();
    await page.waitForTimeout(500);
    const sheetOpacity = await page.evaluate(() => getComputedStyle(document.querySelector('.hall-sheet')).opacity);
    check('Salão no celular reduzido: carta abre já legível', sheetOpacity === '1', sheetOpacity);
    await page.screenshot({ path: path.join(SHOTS, 'salao-carta-celular.png') });
    await page.keyboard.press('Escape');
    check('Salão no celular: sem overflow horizontal', (await overflow(page)) <= 0);
    check('Sem erros no console (Salão, celular)', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  // 13. Lista de presentes: só o convite na página; a lista abre num pergaminho (<dialog>)
  {
    const { context, page, errors, checkouts } = await newPage();
    await page.goto(`${BASE}#presentes`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2200);
    const open = page.getByRole('button', { name: 'Abrir a lista de presentes' });
    check('Presentes: o capítulo mostra só o convite (nenhum presente na página)', (await open.isVisible()) && (await page.locator('.gift-card, .vault').count()) === 0);
    await page.locator('#presentes').screenshot({ path: path.join(SHOTS, 'presentes-capitulo.png') });
    await open.click();
    await page.waitForTimeout(2200);
    const dialog = page.locator('dialog.gift-dialog[open]');
    check('Presentes: o botão abre o pergaminho num diálogo', await dialog.isVisible());
    check('Presentes: foco dentro do pergaminho e página travada', await page.evaluate(() => !!document.activeElement?.closest('dialog.gift-dialog') && getComputedStyle(document.documentElement).overflow === 'hidden'));
    const text = await dialog.innerText();
    check(
      'Presentes: cotas, vaquinhas, sugestões livres e o Cofre Pix',
      (await dialog.locator('.gift-card').count()) === 6 && (await dialog.locator('.gift-free__item').count()) === 2 && (await dialog.locator('.vault').count()) === 1,
    );
    check('Presentes: a cota mostra o valor real do presente (R$ 150,00, sem os custos)', text.includes('R$ 150,00') && !text.includes('R$ 155,94'));
    check(
      'Presentes: vaquinha mostra "R$ X de R$ Y" lido da função',
      text.includes('R$ 3.120,00 de R$ 5.000,00') && (await dialog.locator('[role="progressbar"][aria-valuenow="62"]').count()) === 1,
    );
    await page.screenshot({ path: path.join(SHOTS, 'presentes-lista.png') });

    // Cota com mensagem em segredo: o site manda só o presente e a mensagem (nunca o preço).
    await dialog.getByRole('button', { name: 'Presentear: Uma varinha nova' }).click();
    await page.waitForTimeout(500);
    check('Presentes: escolher abre o presente no mesmo pergaminho', /Uma varinha nova/.test(await dialog.locator('#gift-scroll-title').innerText()));
    const pixButton = dialog.getByRole('button', { name: /^Pix/ });
    const cardButton = dialog.getByRole('button', { name: /^Cartão em até 6x/ });
    check(
      'Presentes: dois botões com o total de cada forma (Pix R$ 151,99; cartão em até 6x R$ 155,94)',
      (await pixButton.innerText()).includes('R$ 151,99') && (await cardButton.innerText()).includes('R$ 155,94'),
    );
    await dialog.getByLabel(/Quero deixar uma mensagem/).check();
    await dialog.locator('#gift-message').fill('Parabéns, Sofia!');
    await pixButton.click();
    await page.waitForTimeout(300);
    check('Presentes: mensagem sem assinatura pede o nome ou o segredo', /Escreva como quer assinar/.test(await dialog.innerText()) && checkouts.length === 0);
    await dialog.getByLabel(/Enviar em segredo/).check();
    await page.screenshot({ path: path.join(SHOTS, 'presentes-formulario.png') });
    await Promise.all([page.waitForURL(/sandbox\.asaas\.com/, { timeout: 8000 }), pixButton.click()]);
    check(
      'Presentes: pede o link à função com a forma escolhida (sem preço) e segue para o Asaas',
      checkouts.length === 1 &&
        JSON.stringify(checkouts[0]) === JSON.stringify({ giftId: 'varinha', method: 'pix', message: 'Parabéns, Sofia!', signature: null, anonymous: true, website: '' }),
      JSON.stringify(checkouts[0]),
    );
    check('Sem erros no console (presentes)', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  // 14. Vaquinha assinada, limite de tentativas e fechar (fundo e Esc)
  {
    const { context, page, errors, checkouts } = await newPage({ checkout: 'busy' });
    await page.goto(`${BASE}#presentes`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'Abrir a lista de presentes' }).click();
    await page.waitForTimeout(2200);
    const dialog = page.locator('dialog.gift-dialog[open]');
    await dialog.getByRole('button', { name: 'Contribuir: A viagem dos sonhos' }).click();
    await page.waitForTimeout(400);
    const fundCard = dialog.getByRole('button', { name: /^Cartão em até 6x/ });
    check('Vaquinha: sem valor, os botões ainda não mostram total', !/R\$/.test(await fundCard.innerText()) && /Digite o valor para ver o total/.test(await dialog.innerText()));
    await dialog.locator('#gift-amount').fill('10');
    await fundCard.click();
    check('Vaquinha: abaixo do mínimo avisa e não pede pagamento', /mínimo é R\$ 20,00/.test(await dialog.innerText()) && checkouts.length === 0);
    await dialog.locator('#gift-amount').fill('150,50');
    check(
      'Vaquinha: mostra o total de cada forma antes de seguir (Pix R$ 152,49)',
      (await dialog.getByRole('button', { name: /^Pix/ }).innerText()).includes('R$ 152,49') && /R\$ \d+,\d{2}/.test(await fundCard.innerText()),
    );
    await dialog.getByLabel(/Quero deixar uma mensagem/).check();
    await dialog.locator('#gift-message').fill('Boa viagem!');
    await dialog.getByPlaceholder('Seu nome').fill('Tio Carlos');
    await fundCard.click();
    await page.waitForTimeout(600);
    check(
      'Vaquinha: manda a forma, o valor em centavos e a assinatura',
      JSON.stringify(checkouts[0]) === JSON.stringify({ giftId: 'viagem', method: 'card', amountCents: 15_050, message: 'Boa viagem!', signature: 'Tio Carlos', anonymous: false, website: '' }),
      JSON.stringify(checkouts[0]),
    );
    check('Presentes: muitas tentativas viram aviso, sem sair do pergaminho', /Muitas tentativas/.test(await dialog.innerText()) && page.url().startsWith(BASE));
    await page.mouse.click(40, 450);
    await page.waitForTimeout(700);
    check(
      'Presentes: clique fora fecha e o foco volta ao botão',
      !(await page.locator('dialog.gift-dialog[open]').count()) && (await page.evaluate(() => document.activeElement?.classList.contains('gifts__open'))),
    );
    await page.getByRole('button', { name: 'Abrir a lista de presentes' }).click();
    await page.waitForTimeout(2200);
    check('Presentes: reabrir volta para a lista', (await page.locator('dialog.gift-dialog[open] .gift-card').count()) === 6);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(700);
    check('Presentes: Esc fecha o pergaminho', !(await page.locator('dialog.gift-dialog[open]').count()));
    check('Sem erros no console (vaquinha)', errors.filter((e) => !/429/.test(e)).length === 0, errors.join(' | '));
    await context.close();
  }

  // 15. Volta do Asaas e pergaminho no celular com movimento reduzido
  {
    const { context, page, errors } = await newPage();
    await page.goto(`${BASE}?presente=enviado`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    check('Volta do Asaas: pula o envelope e abre o agradecimento', !(await page.locator('.opening').count()) && /Sua coruja partiu/.test(await page.locator('dialog.gift-dialog[open]').innerText()));
    check('Volta do Asaas: sem prometer pagamento confirmado', /Assim que o Asaas confirmar/.test(await page.locator('dialog.gift-dialog[open]').innerText()));
    check('Volta do Asaas: endereço limpo (recarregar não repete)', !new URL(page.url()).searchParams.has('presente'), page.url());
    await page.goto(`${BASE}?presente=cancelado`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    check('Volta do Asaas cancelada: lista com o aviso', /não foi concluído/.test(await page.locator('dialog.gift-dialog[open]').innerText()));
    check('Sem erros no console (volta do Asaas)', errors.length === 0, errors.join(' | '));
    await context.close();

    const mobile = await newPage({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    await mobile.page.goto(`${BASE}#presentes`, { waitUntil: 'networkidle' });
    await mobile.page.waitForTimeout(1200);
    await mobile.page.getByRole('button', { name: 'Abrir a lista de presentes' }).tap();
    await mobile.page.waitForTimeout(500);
    const hidden = await mobile.page.evaluate(() =>
      [...document.querySelectorAll('.gift-scroll, .gift-scroll__paper, .gift-scroll__reveal')].filter((el) => getComputedStyle(el).opacity !== '1' || getComputedStyle(el).visibility === 'hidden').length,
    );
    check('Presentes no celular reduzido: pergaminho visível sem animação', hidden === 0, `${hidden} ocultos`);
    const card = await mobile.page.locator('.gift-card__cta').first().boundingBox();
    const close = await mobile.page.locator('.gift-dialog__close').boundingBox();
    check(
      'Presentes no celular: botões inteiros na tela e fáceis de tocar',
      !!card && !!close && card.x >= 0 && card.x + card.width <= 360 && card.height >= 40 && close.x + close.width <= 360 && close.height >= 44,
    );
    check('Presentes no celular: sem overflow horizontal', (await overflow(mobile.page)) <= 0 && (await mobile.page.evaluate(() => document.querySelector('.gift-scroll__body').scrollWidth <= document.querySelector('.gift-scroll__body').clientWidth)));
    await mobile.page.screenshot({ path: path.join(SHOTS, 'presentes-celular.png') });
    await mobile.page.locator('.gift-card__cta').first().tap();
    await mobile.page.waitForTimeout(400);
    const payBoxes = await mobile.page.locator('.gift-pay__btn').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()));
    check(
      'Presentes no celular: os dois botões de pagamento cabem na tela e são fáceis de tocar',
      payBoxes.length === 2 && payBoxes.every((b) => b.x >= 0 && b.right <= 360 && b.height >= 44) &&
        (await mobile.page.evaluate(() => document.querySelector('.gift-scroll__body').scrollWidth <= document.querySelector('.gift-scroll__body').clientWidth)),
      JSON.stringify(payBoxes.map((b) => [Math.round(b.x), Math.round(b.right), Math.round(b.height)])),
    );
    await mobile.page.locator('.gift-pay').scrollIntoViewIfNeeded();
    await mobile.page.screenshot({ path: path.join(SHOTS, 'presentes-celular-pagamento.png') });
    check('Sem erros no console (presentes, celular)', mobile.errors.length === 0, mobile.errors.join(' | '));
    await mobile.context.close();
  }

  // 16. O Profeta Diário (/profeta/): o serviço da VPS é simulado aqui, na mesma origem
  {
    const html = fs.readFileSync(path.join(OUT, 'profeta', 'index.html'), 'utf8');
    check('Profeta: página própria no build, fora do Google (noindex) e com a CSP', /noindex/.test(html) && /Content-Security-Policy/.test(html) && !/og:image/.test(html));

    const PROFETA_DEMO = JSON.parse(fs.readFileSync('scripts/fixtures/profeta-demo.json', 'utf8')).itens;
    const fakeId = (n) => String(n).padStart(20, '0');
    const items = PROFETA_DEMO.map((i) => ({ ...i, mini: `/api/profeta/midia/${fakeId(i.n)}-m.webp`, grande: `/api/profeta/midia/${fakeId(i.n)}-g.jpg` }));
    const photoFor = (url) => PROFETA_DEMO.find((i) => url.includes(fakeId(i.n)))?.mini ?? PROFETA_DEMO[0].mini;
    const openProfeta = async (options = {}) => {
      const ctx = await newPage(options);
      let entered = false;
      const uploads = [];
      await ctx.context.route('**/api/profeta/**', async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        if (url.pathname === '/api/profeta/sessao') return json(200, { entrou: entered, janela: 'aberta' });
        if (url.pathname === '/api/profeta/entrar') {
          if (req.headers()['x-profeta'] !== '1') return json(403, { error: 'pedido_invalido' });
          if (/lumos/i.test(req.postDataJSON()?.senha ?? '')) {
            entered = true;
            return json(200, { ok: true, janela: 'aberta' });
          }
          return json(401, { error: 'senha_errada' });
        }
        if (url.pathname === '/api/profeta/edicao') return entered ? json(200, { mudou: true, v: 1, janela: 'aberta', itens: items }) : json(401, { error: 'sem_sessao' });
        if (url.pathname === '/api/profeta/enviar') {
          uploads.push({ tipo: url.searchParams.get('tipo'), type: req.headers()['content-type'], marker: req.headers()['x-profeta'] });
          return json(202, { ok: true, n: 99 });
        }
        if (url.pathname.startsWith('/api/profeta/midia/')) {
          return route.fulfill({ status: 200, contentType: 'image/webp', body: fs.readFileSync(path.join('public', photoFor(url.pathname))) });
        }
        return json(404, { error: 'nao_encontrada' });
      });
      return { ...ctx, uploads };
    };

    const { context, page, errors, uploads } = await openProfeta({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.goto(`${BASE}profeta/`, { waitUntil: 'networkidle' });
    check('Profeta: pede a palavra mágica antes de mostrar o jornal', (await page.locator('.profeta-gate input').isVisible()) && !(await page.locator('.profeta-columns').count()));
    await page.fill('.profeta-gate input', 'alohomora');
    await page.locator('.profeta-gate button').tap();
    await page.waitForSelector('.profeta-error');
    check('Profeta: palavra errada recusada com aviso', /não é essa/.test(await page.locator('.profeta-error').innerText()));
    await page.fill('.profeta-gate input', 'Lumos Maxima');
    await page.locator('.profeta-gate button').tap();
    await page.waitForSelector('.profeta-photo');
    check('Profeta: jornal com as fotografias e o número de cada uma', (await page.locator('.profeta-photo').count()) === items.length && /Nº 13/.test(await page.locator('.profeta-photo').first().innerText()));
    await page.setInputFiles('.profeta-sender input[type=file]', path.resolve('public/og-sofia.jpg'));
    await page.waitForSelector('.profeta-job--sent', { timeout: 10000 });
    check('Profeta: envio pelo celular chega ao serviço como foto', uploads.length === 1 && uploads[0].tipo === 'foto' && uploads[0].type === 'image/jpeg' && uploads[0].marker === '1', JSON.stringify(uploads));
    check('Profeta celular: sem overflow horizontal', (await overflow(page)) <= 0);
    await page.screenshot({ path: path.join(SHOTS, 'profeta-celular.png') });
    await page.locator('.profeta-photo__frame').first().tap();
    await page.waitForTimeout(400);
    check('Profeta: toque amplia a fotografia num diálogo', await page.locator('dialog.profeta-viewer[open] img').isVisible());
    // O 401 da palavra errada é a resposta esperada (o navegador o registra no console).
    check('Sem erros no console (Profeta)', errors.filter((e) => !/401/.test(e)).length === 0, errors.join(' | '));
    await context.close();

    const reduced = await openProfeta({ reducedMotion: 'reduce' });
    await reduced.page.goto(`${BASE}profeta/`, { waitUntil: 'networkidle' });
    await reduced.page.fill('.profeta-gate input', 'lumos');
    await reduced.page.locator('.profeta-gate button').click();
    await reduced.page.waitForSelector('.profeta-photo');
    const still = await reduced.page.evaluate(
      () =>
        [...document.querySelectorAll('.profeta-photo')].every((el) => getComputedStyle(el).opacity === '1') &&
        [...document.querySelectorAll('.profeta-photo img')].every((el) => getComputedStyle(el).animationName === 'none'),
    );
    check('Profeta reduzido: fotos visíveis e paradas', still);
    check('Sem erros no console (Profeta reduzido)', reduced.errors.length === 0, reduced.errors.join(' | '));
    await reduced.context.close();
  }

  // 9. Sem JavaScript: o <noscript> também leva à Aifos
  {
    const { context, page } = await newPage({ javaScriptEnabled: false });
    await page.goto(BASE, { waitUntil: 'load' });
    const link = page.locator('a[href^="https://wa.me/"]');
    const href = (await link.count()) ? ((await link.first().getAttribute('href')) ?? '') : '';
    check(
      'Sem JavaScript: link visível para o WhatsApp da Aifos',
      href.startsWith('https://wa.me/5511999999999?text=') && (await link.first().isVisible()),
      href,
    );
    await context.close();
  }
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(OUT, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} verificações passaram. Capturas em test-results/`);
process.exit(failed.length ? 1 : 0);
