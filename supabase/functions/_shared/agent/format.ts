/** Texto do modelo → mensagens de WhatsApp. */

const MAX_MESSAGES = 4;
const MAX_CHARS = 700;

/** Markdown comum que escapa do modelo → formatação do WhatsApp. */
export function toWhatsApp(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '_$1_')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Divide a resposta em mensagens curtas, como uma pessoa digitando: um parágrafo
 * por mensagem, juntando parágrafos curtos e limitando a quantidade de envios.
 */
export function splitReply(text: string): string[] {
  const paragraphs = toWhatsApp(text)
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const messages: string[] = [];
  for (const p of paragraphs) {
    const last = messages.at(-1);
    if (last !== undefined && (last.length < 25 || p.length < 25) && last.length + p.length + 2 <= MAX_CHARS) {
      messages[messages.length - 1] = `${last}\n\n${p}`;
    } else {
      messages.push(p);
    }
  }
  if (messages.length > MAX_MESSAGES) {
    const head = messages.slice(0, MAX_MESSAGES - 1);
    return [...head, messages.slice(MAX_MESSAGES - 1).join('\n\n')];
  }
  return messages;
}
