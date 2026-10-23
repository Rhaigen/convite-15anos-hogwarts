/**
 * Link de conversa do WhatsApp (wa.me) e exibição do número da Professora Aifos.
 * Também é lido pelo build (vite.config.ts, conteúdo <noscript>): sem APIs de navegador.
 */

/** Número válido para o wa.me: só dígitos, com DDI (ex.: '5511999999999'). */
export function isWhatsappNumber(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[1-9]\d{9,14}$/.test(value);
}

/** `https://wa.me/<número>?text=<mensagem>`; `null` se o número não for válido. */
export function whatsappUrl(number: string | null, text?: string): string | null {
  if (!isWhatsappNumber(number)) return null;
  const message = text?.trim();
  return `https://wa.me/${number}${message ? `?text=${encodeURIComponent(message)}` : ''}`;
}

/** '5511999999999' → '+55 11 99999-9999' (celular ou fixo do Brasil); outros países: '+<dígitos>'. */
export function formatWhatsappNumber(number: string): string {
  const br = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(number);
  return br ? `+55 ${br[1]} ${br[2]}-${br[3]}` : `+${number}`;
}
