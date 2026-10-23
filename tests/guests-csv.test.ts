import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBoolean, parseCsv, parseGuestsCsv } from '../scripts/lib/guests-csv.mjs';

describe('planilha de convidados (CSV)', () => {
  it('lê o modelo versionado em docs/', () => {
    const { rows, errors } = parseGuestsCsv(readFileSync('docs/convidados-modelo.csv', 'utf8'));
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({
      household: 'Família Exemplo', full_name: 'Carlos Exemplo', phone: '(31) 98888-7777', relationship: 'pai', is_minor: false,
    });
    expect(rows[2]).toEqual({ household: 'Família Exemplo', full_name: 'Pedro Exemplo', relationship: 'filho', is_minor: true });
    expect(rows[3]).toMatchObject({ can_answer_for_household: false });
  });

  it('aceita vírgula, BOM, CRLF, aspas e cabeçalho com acento e maiúsculas', () => {
    const csv = '﻿Família,Nome,Telefone,Pode responder\r\n"Souza, Família","Ana ""Aninha"" Souza",,Sim\r\n\r\n';
    expect(parseGuestsCsv(csv)).toEqual({
      rows: [{ household: 'Souza, Família', full_name: 'Ana "Aninha" Souza', can_answer_for_household: true }],
      errors: [],
    });
  });

  it('aponta colunas ausentes ou desconhecidas e valores fora de sim/não', () => {
    expect(parseGuestsCsv('nome;email\nAna;a@b.c').errors).toEqual([
      'coluna obrigatória ausente: familia',
      'colunas desconhecidas: email',
    ]);
    expect(parseGuestsCsv('familia;nome;menor\nX;Ana;talvez').errors).toEqual([
      'linha 2: valor "talvez" em menor (use sim ou não)',
    ]);
  });

  it('interpreta booleanos em português', () => {
    expect(['Sim', 'S', 'x', 'NÃO', 'nao', '', 'talvez'].map(parseBoolean)).toEqual([
      true, true, true, false, false, null, undefined,
    ]);
    expect(parseCsv('a;"b\nc"\n', ';')).toEqual([['a', 'b\nc']]);
  });
});
