/**
 * Telefones como o WhatsApp entrega: só dígitos, com o código do país.
 * A identidade do convidado é resolvida no banco (public.phone_variants); aqui só
 * o necessário para o código: extrair o número do JID, reconhecer os
 * organizadores e mostrar o número de forma legível.
 */

const DIGITS = /^[1-9]\d{7,14}$/;

/** "5527999990000:12@s.whatsapp.net" → "5527999990000". Null se não for um número. */
export function phoneFromJid(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const [user, server] = jid.split('@');
  if (server !== 's.whatsapp.net' && server !== 'c.us') return null;
  const digits = (user ?? '').split(':')[0] ?? '';
  return DIGITS.test(digits) ? digits : null;
}

/** Formas equivalentes de um celular brasileiro (com e sem o 9º dígito). */
export function phoneVariants(phone: string): string[] {
  const d = phone.replace(/\D/g, '');
  if (!d.startsWith('55')) return [d];
  const area = d.slice(2, 4);
  const local = d.slice(4);
  if (local.length === 9 && local.startsWith('9')) return [d, `55${area}${local.slice(1)}`];
  if (local.length === 8 && /^[6-9]/.test(local)) return [d, `55${area}9${local}`];
  return [d];
}

export function samePhone(a: string, b: string): boolean {
  const vb = new Set(phoneVariants(b));
  return phoneVariants(a).some((v) => vb.has(v));
}

/** "5527999990000, +55 (27) 98888-7777" → ["5527999990000", "5527988887777"]. */
export function parsePhoneList(value: string | null | undefined): string[] {
  return (value ?? '')
    .split(/[,;\n]+/)
    .map((p) => p.replace(/\D/g, ''))
    .filter((p) => DIGITS.test(p));
}

/** "5527999990000" → "+55 27 99999-0000" (outros países: "+<dígitos>"). */
export function formatPhone(phone: string): string {
  const d = phone.replace(/\D/g, '');
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(d);
  return m ? `+55 ${m[1]} ${m[2]}-${m[3]}` : `+${d}`;
}
