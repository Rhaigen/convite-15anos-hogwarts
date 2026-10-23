import type { PixConfig, PixKeyType } from '../types/content';

/**
 * Geração do "Pix Copia e Cola" estático (BR Code, padrão EMV-QRCPS do Banco
 * Central). Só produz um código quando chave, recebedor e cidade são válidos —
 * caso contrário retorna `null` e nenhum QR Code é exibido.
 */

const tlv = (id: string, value: string) => `${id}${String(value.length).padStart(2, '0')}${value}`;

/** CRC16-CCITT (polinômio 0x1021, valor inicial 0xFFFF), exigido pelo BR Code. */
export function crc16(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Remove acentos e caracteres fora do conjunto aceito pelos bancos. */
export function sanitizePixText(value: string, maxLength: number): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9 .,-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
}

/** Normaliza e valida a chave conforme o tipo; `null` se inválida. */
export function normalizePixKey(key: string, type: PixKeyType): string | null {
  const raw = key.trim();
  switch (type) {
    case 'cpf': {
      const digits = raw.replace(/\D/g, '');
      return digits.length === 11 ? digits : null;
    }
    case 'cnpj': {
      const digits = raw.replace(/\D/g, '');
      return digits.length === 14 ? digits : null;
    }
    case 'phone': {
      const digits = raw.replace(/\D/g, '');
      const full = digits.length === 10 || digits.length === 11 ? `55${digits}` : digits;
      return /^55\d{10,11}$/.test(full) ? `+${full}` : null;
    }
    case 'email': {
      const email = raw.toLowerCase();
      return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email) && email.length <= 77 ? email : null;
    }
    case 'random': {
      const evp = raw.toLowerCase();
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(evp) ? evp : null;
    }
  }
}

export interface PixPayloadInput {
  key: string;
  name: string;
  city: string;
  /** Identificador da transação; "***" para QR estático sem identificação. */
  txid?: string;
}

export function buildPixPayload({ key, name, city, txid = '***' }: PixPayloadInput): string {
  const merchantAccount = tlv('00', 'br.gov.bcb.pix') + tlv('01', key);
  const payload =
    tlv('00', '01') +
    tlv('26', merchantAccount) +
    tlv('52', '0000') +
    tlv('53', '986') +
    tlv('58', 'BR') +
    tlv('59', name) +
    tlv('60', city) +
    tlv('62', tlv('05', txid)) +
    '6304';
  return payload + crc16(payload);
}

export interface PixDisplay {
  /** Chave exatamente como deve ser copiada. */
  key: string;
  keyTypeLabel: string;
  recipientName: string | null;
  city: string | null;
  /** Pix Copia e Cola (quando todos os dados obrigatórios forem válidos). */
  payload: string | null;
}

const KEY_LABELS: Record<PixKeyType, string> = {
  cpf: 'CPF',
  cnpj: 'CNPJ',
  email: 'E-mail',
  phone: 'Telefone',
  random: 'Chave aleatória',
};

/** Prepara os dados exibidos a partir da configuração. `null` se não houver chave. */
export function resolvePix(config: PixConfig): PixDisplay | null {
  if (!config.enabled || !config.key || !config.keyType) return null;
  const normalized = normalizePixKey(config.key, config.keyType);
  const name = config.recipientName ? sanitizePixText(config.recipientName, 25) : '';
  const city = config.city ? sanitizePixText(config.city, 15).toUpperCase() : '';
  const payload = normalized && name.length > 0 && city.length > 0 ? buildPixPayload({ key: normalized, name, city }) : null;
  return {
    // Telefone aparece e é copiado como a família anota (DDD + número); o +55 só vai no Copia e Cola,
    // onde o padrão do Banco Central exige o formato internacional.
    key: normalized && config.keyType === 'phone' ? normalized.slice('+55'.length) : (normalized ?? config.key.trim()),
    keyTypeLabel: KEY_LABELS[config.keyType],
    recipientName: config.recipientName,
    city: config.city,
    payload,
  };
}
