/**
 * Leitura da planilha de convidados (CSV exportado do Excel ou do Google Sheets).
 * Só interpreta o arquivo; a validação de verdade (telefones, famílias, menores,
 * duplicados) é feita pelo banco em public.admin_import_guests, com testes em PGlite.
 *
 * Colunas (cabeçalho obrigatório, sem diferenciar maiúsculas nem acentos):
 *   familia | nome | telefone | parentesco | menor | pode_responder
 */

const COLUMNS = {
  familia: 'household',
  nome: 'full_name',
  telefone: 'phone',
  parentesco: 'relationship',
  menor: 'is_minor',
  pode_responder: 'can_answer_for_household',
};
const REQUIRED = ['familia', 'nome'];

const normalizeHeader = (h) =>
  h
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

/** Divide o texto em linhas e campos, respeitando aspas ("a;b", "diz ""oi""") e quebras dentro delas. */
export function parseCsv(text, separator) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === separator) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/** "sim", "s", "x", "true", "1" → true; "não", "nao", "n", "false", "0" → false; vazio → null. */
export function parseBoolean(value) {
  const v = normalizeHeader(value ?? '');
  if (v === '') return null;
  if (['sim', 's', 'x', 'true', '1', 'yes', 'y'].includes(v)) return true;
  if (['nao', 'n', 'false', '0', 'no'].includes(v)) return false;
  return undefined;
}

/**
 * @returns {{ rows: object[], errors: string[] }} linhas no formato de admin_import_guests
 */
export function parseGuestsCsv(text) {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? '';
  const separator = (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const [header, ...lines] = parseCsv(clean, separator);
  const errors = [];

  if (!header) return { rows: [], errors: ['arquivo vazio'] };
  const keys = header.map(normalizeHeader);
  for (const required of REQUIRED) {
    if (!keys.includes(required)) errors.push(`coluna obrigatória ausente: ${required}`);
  }
  const unknown = keys.filter((k) => k && !(k in COLUMNS));
  if (unknown.length) errors.push(`colunas desconhecidas: ${unknown.join(', ')}`);
  if (errors.length) return { rows: [], errors };

  const rows = lines.map((fields, index) => {
    const row = {};
    keys.forEach((key, col) => {
      const target = COLUMNS[key];
      if (!target) return;
      const raw = (fields[col] ?? '').trim();
      if (target === 'is_minor' || target === 'can_answer_for_household') {
        const parsed = parseBoolean(raw);
        // +2: cabeçalho e numeração a partir de 1, como no Excel.
        if (parsed === undefined) errors.push(`linha ${index + 2}: valor "${raw}" em ${key} (use sim ou não)`);
        else if (parsed !== null) row[target] = parsed;
      } else if (raw !== '') {
        row[target] = raw;
      }
    });
    return row;
  });

  return { rows, errors };
}
