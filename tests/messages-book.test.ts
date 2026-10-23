/**
 * Livro de Recados (npm run messages:book): o texto dos convidados é dado, nunca
 * HTML; parágrafos e assinatura saem como a Aifos guardou.
 */
import { describe, expect, it } from 'vitest';
import { renderBook } from '../scripts/lib/messages-book.ts';
import type { GuestMessageEntry } from '../supabase/functions/_shared/whatsapp/report.ts';

const entry = (over: Partial<GuestMessageEntry>): GuestMessageEntry => ({
  full_name: 'Carlos Souza',
  household: 'Família Souza',
  signature: null,
  body: 'Parabéns!',
  source: 'text',
  created_at: '2026-11-10T12:00:00Z',
  updated_at: '2026-11-10T12:00:00Z',
  ...over,
});

const options = { celebrant: 'Sofia', dateLabel: 'sábado, 20 de fevereiro de 2027' };

describe('Livro de Recados', () => {
  it('capa com a aniversariante, a data e a contagem', () => {
    const html = renderBook([entry({}), entry({ full_name: 'Bia Souza' })], options);
    expect(html).toContain('<h1 class="cover__title">Sofia</h1>');
    expect(html).toContain('15 anos · sábado, 20 de fevereiro de 2027 · 2 recados');
    expect(renderBook([entry({})], options)).toContain('· 1 recado</p>');
    expect(renderBook([], options)).toContain('Ainda não há recados.');
  });

  it('escapa o texto dos convidados e mantém os parágrafos', () => {
    const html = renderBook([entry({ body: 'Oi <script>alert(1)</script> & "beijos"\n\nSegundo\nlinha', signature: '<b>Tio</b>' })], options);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('<p>Oi &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;beijos&quot;</p><p>Segundo<br>linha</p>');
    expect(html).toContain('<p class="note__signature">&lt;b&gt;Tio&lt;/b&gt;</p>');
  });

  it('assina com o nome quando não há assinatura; com assinatura, mostra quem escreveu', () => {
    const plain = renderBook([entry({})], options);
    expect(plain).toContain('<p class="note__signature">Carlos Souza</p>');
    expect(plain).toContain('<p class="note__meta">Família Souza</p>');
    const signed = renderBook([entry({ signature: 'Tio Carlos e Marta' })], options);
    expect(signed).toContain('<p class="note__signature">Tio Carlos e Marta</p>');
    expect(signed).toContain('<p class="note__meta">Carlos Souza · Família Souza</p>');
  });

  it('recados que vieram com presentes: seção própria, assinados ou em segredo, sem valores', () => {
    const gifts = [
      { gift_name: 'A viagem', signature: 'Padrinho', anonymous: false, body: 'Boa viagem!', paid_at: '2026-12-01T12:00:00Z' },
      { gift_name: 'Uma <varinha>', signature: null, anonymous: true, body: 'Segredo', paid_at: '2026-12-02T12:00:00Z' },
    ];
    const html = renderBook([entry({})], options, gifts);
    expect(html).toContain('<h2 class="section-title">Recados que vieram com presentes</h2>');
    expect(html).toContain('<p class="note__signature">Padrinho</p>');
    expect(html).toContain('<p class="note__signature">Em segredo</p>');
    expect(html).toContain('junto com o presente “Uma &lt;varinha&gt;”');
    expect(html).toContain('· 3 recados');
    expect(html).not.toMatch(/R\$|\d+,\d{2}/);
    // Só presentes: sem o aviso de livro vazio.
    expect(renderBook([], options, gifts)).not.toContain('Ainda não há recados.');
    expect(renderBook([], options)).not.toContain('Recados que vieram com presentes');
  });
});
