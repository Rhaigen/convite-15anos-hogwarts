import { describe, expect, it } from 'vitest';
import { buildPixPayload, crc16, normalizePixKey, resolvePix, sanitizePixText } from '../src/lib/pix';

// Exemplo oficial do Manual de Padrões para Iniciação do Pix (Banco Central do Brasil).
const BCB_EXAMPLE =
  '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D';

describe('Pix BR Code', () => {
  it('calcula o CRC16 igual ao exemplo oficial do Banco Central', () => {
    expect(crc16(BCB_EXAMPLE.slice(0, -4))).toBe('1D3D');
  });

  it('gera exatamente o payload do exemplo oficial', () => {
    const payload = buildPixPayload({ key: '123e4567-e12b-12d1-a456-426655440000', name: 'Fulano de Tal', city: 'BRASILIA' });
    expect(payload).toBe(BCB_EXAMPLE);
  });

  it('normaliza e valida chaves por tipo', () => {
    expect(normalizePixKey('123.456.789-09', 'cpf')).toBe('12345678909');
    expect(normalizePixKey('123', 'cpf')).toBeNull();
    expect(normalizePixKey('12.345.678/0001-90', 'cnpj')).toBe('12345678000190');
    expect(normalizePixKey('(11) 98765-4321', 'phone')).toBe('+5511987654321');
    expect(normalizePixKey('+55 11 98765-4321', 'phone')).toBe('+5511987654321');
    expect(normalizePixKey(' Familia@Exemplo.com ', 'email')).toBe('familia@exemplo.com');
    expect(normalizePixKey('nao-e-email', 'email')).toBeNull();
    expect(normalizePixKey('123E4567-E12B-12D1-A456-426655440000', 'random')).toBe('123e4567-e12b-12d1-a456-426655440000');
  });

  it('remove acentos e limita nome/cidade ao tamanho do padrão', () => {
    expect(sanitizePixText('João Albuquerque Prado da Conceição', 25)).toBe('Joao Albuquerque Prado da');
    expect(sanitizePixText('São Paulo', 15)).toBe('Sao Paulo');
  });

  it('não gera nada sem chave configurada (nenhum QR Code inventado)', () => {
    const base = { enabled: true, key: null, keyType: null, recipientName: null, city: null, qrCodeImage: null };
    expect(resolvePix(base)).toBeNull();
    expect(resolvePix({ ...base, enabled: false, key: 'a@b.com', keyType: 'email' })).toBeNull();
  });

  it('exibe a chave mas não gera QR Code quando faltam recebedor ou cidade', () => {
    const pix = resolvePix({ enabled: true, key: 'a@b.com', keyType: 'email', recipientName: 'Maria', city: null, qrCodeImage: null });
    expect(pix?.key).toBe('a@b.com');
    expect(pix?.payload).toBeNull();
  });

  it('telefone sem +55 na tela e no copiar, com +55 no Copia e Cola', () => {
    const pix = resolvePix({ enabled: true, key: '+55 11 99999-9999', keyType: 'phone', recipientName: 'Maria', city: 'Vila Velha', qrCodeImage: null });
    expect(pix?.key).toBe('11999999999');
    expect(pix?.payload).toContain('0114+5511999999999');
  });

  it('gera payload válido com dados completos', () => {
    const pix = resolvePix({
      enabled: true,
      key: 'a@b.com',
      keyType: 'email',
      recipientName: 'Maria Ávila',
      city: 'Belo Horizonte',
      qrCodeImage: null,
    });
    expect(pix?.payload).toMatch(/^000201.*5911Maria Avila6014BELO HORIZONTE.*6304[0-9A-F]{4}$/);
    const payload = pix!.payload!;
    expect(crc16(payload.slice(0, -4))).toBe(payload.slice(-4));
  });
});
