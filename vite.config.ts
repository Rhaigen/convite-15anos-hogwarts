/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { event } from './src/content/event.ts';
import { giftsConfig, messageWallConfig, rsvpConfig } from './src/content/settings.ts';
import { siteMeta } from './src/content/site.ts';
import { rsvp } from './src/content/texts.ts';
import { formatDateLong, formatTime } from './src/lib/date.ts';
import { formatWhatsappNumber, whatsappUrl } from './src/lib/whatsapp.ts';
import { profetaTexts } from './src/content/profeta.ts';

/** Origem (https://host) de um endereço das funções públicas, para a CSP; null se não houver ou for inválido. */
function endpointOrigin(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const { origin } = new URL(url);
    return /^https?:\/\//.test(origin) ? origin : null;
  } catch {
    return null;
  }
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Injeta no index.html (convite) e no profeta/index.html (O Profeta Diário) os metadados de SEO/compartilhamento e o conteúdo
 * <noscript> a partir da configuração central do evento, evitando textos
 * duplicados e divergentes. Em produção, adiciona também uma CSP restritiva.
 */
function invitationHtml(env: Record<string, string>, isBuild: boolean): Plugin {
  const siteUrl = (env.VITE_SITE_URL || siteMeta.url || '').trim().replace(/\/+$/, '');
  const allowIndexing = env.VITE_ALLOW_INDEXING === 'true';

  const meta: string[] = [
    `<title>${escapeHtml(siteMeta.title)}</title>`,
    `<meta name="description" content="${escapeHtml(siteMeta.description)}" />`,
    `<meta name="theme-color" content="${siteMeta.themeColor}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:locale" content="pt_BR" />`,
    `<meta property="og:title" content="${escapeHtml(siteMeta.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(siteMeta.description)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapeHtml(siteMeta.title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(siteMeta.description)}" />`,
  ];
  if (siteUrl) {
    meta.push(
      `<link rel="canonical" href="${escapeHtml(siteUrl)}/" />`,
      `<meta property="og:url" content="${escapeHtml(siteUrl)}/" />`,
      `<meta property="og:image" content="${escapeHtml(siteUrl + siteMeta.ogImage)}" />`,
      `<meta property="og:image:width" content="1200" />`,
      `<meta property="og:image:height" content="630" />`,
      `<meta property="og:image:alt" content="${escapeHtml(siteMeta.ogImageAlt)}" />`,
      `<meta name="twitter:image" content="${escapeHtml(siteUrl + siteMeta.ogImage)}" />`,
    );
  }
  if (!allowIndexing) meta.push(`<meta name="robots" content="noindex, nofollow" />`);

  // O Profeta Diário: fora do Google sempre, sem metadados de compartilhamento (fotos dos convidados).
  const profetaMeta: string[] = [
    `<title>${escapeHtml(profetaTexts.pageTitle)}</title>`,
    `<meta name="theme-color" content="${siteMeta.themeColor}" />`,
    `<meta name="robots" content="noindex, nofollow, noarchive, noimageindex" />`,
    `<meta name="referrer" content="same-origin" />`,
  ];

  if (isBuild) {
    // De fora, só as funções públicas (sem chave): cartas do Salão Principal e lista de presentes.
    const origins = [
      env.VITE_MESSAGES_URL || messageWallConfig.endpoint,
      env.VITE_GIFT_CHECKOUT_URL || giftsConfig.checkoutEndpoint,
      env.VITE_GIFT_PROGRESS_URL || giftsConfig.progressEndpoint,
    ]
      .map(endpointOrigin)
      .filter((o, i, all): o is string => o !== null && all.indexOf(o) === i);
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self'",
      // A confirmação é feita pela Professora Aifos no WhatsApp; o site lê as cartas do Salão e o
      // progresso das vaquinhas, e pede o link de pagamento da lista (o pagamento é no Asaas).
      // O Profeta Diário fala com /api/profeta, na mesma origem ('self').
      `connect-src 'self'${origins.map((o) => ` ${o}`).join('')}`,
      "media-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ');
    meta.push(`<meta http-equiv="Content-Security-Policy" content="${csp}" />`);
    profetaMeta.push(`<meta http-equiv="Content-Security-Policy" content="${csp}" />`);
  }

  const waUrl = whatsappUrl(rsvpConfig.whatsappNumber, rsvp.greeting);
  const messageUrl = whatsappUrl(rsvpConfig.whatsappNumber, rsvp.messageGreeting);
  const when = `${formatDateLong(event.date)}${event.time ? `, às ${formatTime(event.time)}` : ''}`;
  const noscript = `
      <div class="noscript-letter">
        <p class="noscript-kicker">Convite</p>
        <h1>${escapeHtml(event.celebrant)}</h1>
        <p>Celebração dos 15 anos</p>
        <p><strong>Data:</strong> ${escapeHtml(when)}</p>
        <p><strong>Local:</strong> ${escapeHtml(event.venue)}${event.address ? ` — ${escapeHtml(event.address)}` : ''}</p>${
          rsvpConfig.enabled && waUrl && rsvpConfig.whatsappNumber
            ? `
        <p><strong>Confirmação de presença:</strong> pelo WhatsApp da Professora Aifos, <a href="${escapeHtml(waUrl)}">${escapeHtml(formatWhatsappNumber(rsvpConfig.whatsappNumber))}</a>.</p>${
          messageUrl ? `
        <p><strong>Recado para a Sofia:</strong> a Professora Aifos também guarda o seu, <a href="${escapeHtml(messageUrl)}">é só escrever para ela</a>.</p>` : ''
        }`
            : ''
        }
        <p>Ative o JavaScript do navegador para abrir a experiência completa e ver a lista de presentes.</p>
      </div>`;

  return {
    name: 'invitation-html',
    transformIndexHtml(html) {
      return html
        .replace('<!--app-meta-->', meta.join('\n    '))
        .replace('<!--app-noscript-->', noscript)
        .replace('<!--profeta-meta-->', profetaMeta.join('\n    '));
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    plugins: [react(), tailwindcss(), invitationHtml(env, command === 'build')],
    define: {
      // Lista de presentes fictícia no build: só o e2e liga. Falsa = o código some do bundle.
      __GIFTS_DEMO__: JSON.stringify(env.VITE_E2E_GIFTS_DEMO === 'true'),
    },
    build: {
      target: 'es2022',
      sourcemap: false,
      // Duas páginas: o convite e O Profeta Diário (/profeta/), com bundles separados.
      rollupOptions: { input: { main: 'index.html', profeta: 'profeta/index.html' } },
    },
    // No dev, VITE_PROFETA_PROXY=http://localhost:8799 leva /api/profeta ao serviço local (services/profeta).
    server: env.VITE_PROFETA_PROXY ? { proxy: { '/api/profeta': env.VITE_PROFETA_PROXY } } : undefined,
    test: {
      include: ['tests/**/*.test.ts'],
      environment: 'node',
      testTimeout: 30_000,
    },
  };
});
