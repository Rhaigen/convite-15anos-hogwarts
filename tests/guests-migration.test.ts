/**
 * Executa as migrações SQL reais em um Postgres embutido (PGlite, com pg_trgm e fuzzystrmatch)
 * e verifica a lista de convidados e as funções da Professora Aifos:
 *  - normalização de nomes e telefones (inclusive o 9º dígito dos celulares);
 *  - importação da planilha (validação, reimportação sem duplicar);
 *  - identidade pelo telefone ou pela busca por nome, e o que cada um pode fazer;
 *  - regras da resposta: mesma família, menores, prazo, tudo ou nada, auditoria;
 *  - inbox idempotente, trava por telefone, tetos diários, memória append-only;
 *  - isolamento: anon/authenticated não leem tabelas nem executam funções do bot.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { fuzzystrmatch } from '@electric-sql/pglite/contrib/fuzzystrmatch';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const migrationsDir = join(process.cwd(), 'supabase', 'migrations');
const migrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(migrationsDir, f), 'utf8'));

// Telefones como o WhatsApp entrega (só dígitos).
const CARLOS = '5531988887777';
const CARLOS_SEM_9 = '553188887777';
const MARTA = '5531977776666';
const BIA = '5531966665555';
const JOAO = '5521999990000';
const DESCONHECIDO = '5511912345678';
const OUTRO = '5511987654321';

const GUESTS = [
  { household: 'Família Souza', full_name: 'Carlos Souza', phone: '(31) 98888-7777', relationship: 'pai' },
  { household: 'Família Souza', full_name: 'Marta Souza', phone: '31 97777-6666', relationship: 'mãe' },
  { household: 'Família Souza', full_name: 'Pedro Souza', relationship: 'filho', is_minor: true },
  { household: 'Família Souza', full_name: 'Bia Souza', phone: '+55 31 96666-5555', relationship: 'filha', is_minor: true },
  { household: 'Família Souza', full_name: 'Ana Paula Souza Lima', relationship: 'filha' },
  { household: 'Família Barbosa', full_name: 'João Carlos Barbosa', phone: '21 99999-0000', relationship: 'tio' },
  { household: 'Família Barbosa', full_name: 'Joana Barbosa', relationship: 'tia' },
  { household: 'Vovó Lúcia', full_name: 'Lúcia Helena Dias', relationship: 'avó' },
];

let db: PGlite;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function as<T = Json>(role: string, sql: string, params: unknown[] = []): Promise<T[]> {
  await db.exec(`set role ${role}`);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec('reset role');
  }
}

/** Chama uma função do bot como o service_role (papel das Edge Functions). */
async function bot<T = Json>(call: string, params: unknown[] = []): Promise<T> {
  const rows = await as<{ r: T }>('service_role', `select ${call} as r`, params);
  return rows[0]!.r;
}

async function guestId(name: string): Promise<string> {
  const r = await db.query<{ id: string }>('select id from public.guests where full_name = $1', [name]);
  return r.rows[0]!.id;
}

async function status(name: string): Promise<string> {
  const r = await db.query<{ rsvp_status: string }>('select rsvp_status from public.guests where full_name = $1', [name]);
  return r.rows[0]!.rsvp_status;
}

const importGuests = (rows: unknown[], apply = true) =>
  bot('public.admin_import_guests($1::jsonb, $2)', [JSON.stringify(rows), apply]);

const setRsvp = (phone: string, names: string[], s: string) =>
  Promise.all(names.map(guestId)).then((ids) =>
    bot('public.bot_set_rsvp($1, $2::uuid[], $3, $4)', [phone, ids, s, 'wamid-1']),
  );

beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm, fuzzystrmatch } });
  // Papéis e privilégios padrão de todo projeto Supabase.
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  `);
  for (const sql of migrations) await db.exec(sql);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(`
    truncate public.households, public.guests, public.rsvp_events, public.wa_contacts, public.bot_usage cascade;
    update public.rsvp_settings
       set accepting_responses = true, deadline = null, turns_per_phone_per_day = 40, turns_per_day = 800
     where id = 1;
    update public.message_wall_settings set unseal_at = '2027-02-20 00:00:00-03' where id = 1;
  `);
  const r = await importGuests(GUESTS);
  expect(r.errors).toEqual([]);
});

describe('normalização', () => {
  it('normaliza nomes sem acento, pontuação nem espaços extras', async () => {
    expect(await bot(`public.normalize_name($1)`, ["  José  D'Ávila Conceição "])).toBe('jose d avila conceicao');
  });

  it('normaliza telefones brasileiros e estrangeiros para E.164', async () => {
    const cases: [string, string | null][] = [
      ['(31) 98888-7777', '+5531988887777'],
      ['(31) 8888-7777', '+5531988887777'], // celular antigo ganha o 9
      ['031 98888 7777', '+5531988887777'],
      ['+55 31 98888-7777', '+5531988887777'],
      ['5531988887777', '+5531988887777'],
      ['(31) 3333-4444', '+553133334444'], // fixo
      ['+1 415 555 0100', '+14155550100'],
      ['98888-7777', null], // sem DDD
      ['abc', null],
      ['', null],
    ];
    for (const [input, expected] of cases) {
      expect(await bot('public.normalize_phone($1)', [input]), input).toBe(expected);
    }
  });

  it('gera as variantes com e sem o 9 para o número vindo do WhatsApp', async () => {
    expect(await bot('public.phone_variants($1)', [CARLOS])).toEqual(['+5531988887777', '+553188887777']);
    expect(await bot('public.phone_variants($1)', [CARLOS_SEM_9])).toEqual(['+553188887777', '+5531988887777']);
    expect(await bot('public.phone_variants($1)', ['14155550100'])).toEqual(['+14155550100']);
    expect(await bot('public.phone_variants($1)', ['12'])).toEqual([]);
  });
});

describe('importação da planilha', () => {
  it('a simulação valida sem gravar', async () => {
    await db.exec('truncate public.households cascade');
    const r = await importGuests(GUESTS, false);
    expect(r).toMatchObject({ ok: true, applied: false, rows: 8, households: 3 });
    const n = await db.query<{ n: number }>('select count(*)::int as n from public.guests');
    expect(n.rows[0]!.n).toBe(0);
  });

  it('grava famílias e convidados com padrões coerentes', async () => {
    const rows = await db.query<Json>(
      `select g.full_name, g.phone_e164, g.is_minor, g.can_answer_for_household, g.rsvp_status, h.label
         from public.guests g join public.households h on h.id = g.household_id order by g.full_name`,
    );
    expect(rows.rows).toHaveLength(8);
    expect(rows.rows.find((g) => g.full_name === 'Carlos Souza')).toMatchObject({
      phone_e164: '+5531988887777', can_answer_for_household: true, rsvp_status: 'pending', label: 'Família Souza',
    });
    expect(rows.rows.find((g) => g.full_name === 'Pedro Souza')).toMatchObject({
      phone_e164: null, is_minor: true, can_answer_for_household: false,
    });
  });

  it('reimportar atualiza sem duplicar e preserva as respostas', async () => {
    await setRsvp(CARLOS, ['Carlos Souza'], 'attending');
    const changed = GUESTS.map((g) => (g.full_name === 'Joana Barbosa' ? { ...g, phone: '21 98888-1111' } : g));
    const r = await importGuests(changed);
    expect(r).toMatchObject({ ok: true, applied: true, inserted: 0, updated: 8 });
    expect(await status('Carlos Souza')).toBe('attending');
    const joana = await db.query<Json>("select phone_e164 from public.guests where full_name = 'Joana Barbosa'");
    expect(joana.rows[0]!.phone_e164).toBe('+5521988881111');
  });

  it('recusa a planilha inteira quando há erros', async () => {
    await db.exec('truncate public.households cascade');
    const r = await importGuests([
      { household: 'Família X', full_name: 'Ana Xavier', phone: '12345' },
      { household: 'Família X', full_name: 'Bruno Xavier', phone: '(11) 91234-5678' },
      { household: 'Família X', full_name: 'Caio Xavier', phone: '11 91234-5678' },
      { household: 'Família X', full_name: 'Duda Xavier', is_minor: true, can_answer_for_household: true },
      { household: 'Família X', full_name: 'DUDA  xavier' },
      { household: '', full_name: 'Sem Família' },
    ]);
    expect(r.ok).toBe(false);
    expect(r.applied).toBe(false);
    expect(r.errors.join('\n')).toMatch(/linha 1: telefone inválido/);
    expect(r.errors.join('\n')).toMatch(/telefone repetido \+5511912345678: Bruno Xavier, Caio Xavier/);
    expect(r.errors.join('\n')).toMatch(/linha 4: menor de idade não pode responder/);
    expect(r.errors.join('\n')).toMatch(/nome repetido na mesma família \(linhas 4, 5\)/);
    expect(r.errors.join('\n')).toMatch(/linha 6: família em branco/);
    const n = await db.query<{ n: number }>('select count(*)::int as n from public.guests');
    expect(n.rows[0]!.n).toBe(0);
  });

  it('avisa sobre famílias sem adulto com telefone e convidados fora da planilha', async () => {
    const r = await importGuests(GUESTS.filter((g) => g.full_name !== 'Joana Barbosa'), false);
    expect(r.ok).toBe(true);
    expect(r.warnings.join('\n')).toMatch(/família sem adulto com telefone: Vovó Lúcia/);
    expect(r.warnings.join('\n')).toMatch(/fora da planilha.*Joana Barbosa/);
  });

  it('recusa telefone que já pertence a outro convidado no banco', async () => {
    const r = await importGuests([{ household: 'Família Nova', full_name: 'Intruso Silva', phone: '31 98888-7777' }], false);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/já pertence a Carlos Souza/);
  });
});

describe('identificação e situação da família', () => {
  it('telefone desconhecido não é identificado', async () => {
    expect(await bot('public.bot_household_status($1)', [DESCONHECIDO])).toMatchObject({
      identified: false, rsvp_open: true,
    });
  });

  it('pelo telefone (com ou sem o 9), o adulto vê a família inteira, menores incluídos', async () => {
    for (const phone of [CARLOS, CARLOS_SEM_9]) {
      const s = await bot('public.bot_household_status($1)', [phone]);
      expect(s).toMatchObject({ identified: true, verified_by: 'phone', household: 'Família Souza' });
      expect(s.members).toHaveLength(5);
      expect(s.members[0]).toMatchObject({ full_name: 'Carlos Souza', is_you: true, can_answer: true });
      expect(s.members.every((m: Json) => m.can_answer)).toBe(true);
    }
  });

  it('o menor com telefone vê a família, mas só pode responder por si', async () => {
    const s = await bot('public.bot_household_status($1)', [BIA]);
    const answerable = s.members.filter((m: Json) => m.can_answer).map((m: Json) => m.full_name);
    expect(answerable).toEqual(['Bia Souza']);
  });

  it('nunca expõe outra família', async () => {
    const s = await bot('public.bot_household_status($1)', [JOAO]);
    expect(s.members.map((m: Json) => m.full_name).sort()).toEqual(['Joana Barbosa', 'João Carlos Barbosa']);
  });
});

describe('registrar resposta', () => {
  it('o responsável confirma por si e pelo filho sem telefone, com auditoria', async () => {
    const r = await setRsvp(CARLOS, ['Carlos Souza', 'Pedro Souza'], 'attending');
    expect(r.ok).toBe(true);
    expect(r.results).toHaveLength(2);
    expect(r.results.every((x: Json) => x.changed && x.previous_status === 'pending')).toBe(true);
    expect(await status('Pedro Souza')).toBe('attending');

    const ev = await db.query<Json>(
      `select e.new_status, e.origin_phone, e.wa_message_id, e.channel, a.full_name as actor
         from public.rsvp_events e join public.guests a on a.id = e.actor_guest_id order by e.id`,
    );
    expect(ev.rows).toHaveLength(2);
    expect(ev.rows[0]).toMatchObject({ new_status: 'attending', origin_phone: CARLOS, wa_message_id: 'wamid-1', channel: 'whatsapp', actor: 'Carlos Souza' });
  });

  it('repetir a mesma resposta não gera nova auditoria; mudar gera', async () => {
    await setRsvp(CARLOS, ['Carlos Souza'], 'attending');
    const again = await setRsvp(CARLOS, ['Carlos Souza'], 'attending');
    expect(again.results[0]).toMatchObject({ changed: false, previous_status: 'attending' });
    await setRsvp(CARLOS, ['Carlos Souza'], 'declined');
    const n = await db.query<{ n: number }>('select count(*)::int as n from public.rsvp_events');
    expect(n.rows[0]!.n).toBe(2);
    expect(await status('Carlos Souza')).toBe('declined');
  });

  it('não responde por outra família, e o pedido inteiro é recusado (tudo ou nada)', async () => {
    const r = await setRsvp(CARLOS, ['Carlos Souza', 'Joana Barbosa'], 'attending');
    expect(r).toMatchObject({ ok: false, error: 'not_in_household' });
    expect(await status('Carlos Souza')).toBe('pending');
  });

  it('menor não responde pela família', async () => {
    expect(await setRsvp(BIA, ['Pedro Souza'], 'attending')).toMatchObject({ ok: false, error: 'not_allowed' });
    expect(await setRsvp(BIA, ['Bia Souza'], 'attending')).toMatchObject({ ok: true });
  });

  it('valida status, destinos e identificação', async () => {
    expect(await setRsvp(CARLOS, ['Carlos Souza'], 'maybe')).toMatchObject({ ok: false, error: 'invalid_status' });
    expect(await setRsvp(CARLOS, [], 'attending')).toMatchObject({ ok: false, error: 'no_targets' });
    expect(await setRsvp(DESCONHECIDO, ['Carlos Souza'], 'attending')).toMatchObject({ ok: false, error: 'not_identified' });
    const ghost = await bot('public.bot_set_rsvp($1, $2::uuid[], $3)', [CARLOS, ['00000000-0000-4000-8000-000000000000'], 'attending']);
    expect(ghost).toMatchObject({ ok: false, error: 'not_in_household' });
  });

  it('respeita o encerramento e o prazo', async () => {
    await db.exec('update public.rsvp_settings set accepting_responses = false where id = 1');
    expect(await setRsvp(CARLOS, ['Carlos Souza'], 'attending')).toMatchObject({ ok: false, error: 'rsvp_closed' });
    await db.exec("update public.rsvp_settings set accepting_responses = true, deadline = now() - interval '1 minute' where id = 1");
    expect(await setRsvp(CARLOS, ['Carlos Souza'], 'attending')).toMatchObject({ ok: false, error: 'rsvp_closed' });
    expect(await bot('public.bot_household_status($1)', [CARLOS])).toMatchObject({ rsvp_open: false });
  });
});

describe('busca por nome e vínculo do telefone', () => {
  const find = (name: string) => bot('public.bot_find_guest_by_name($1)', [name]);
  const link = (phone: string, id: string) => bot('public.bot_link_contact($1, $2::uuid)', [phone, id]);

  it('tolera acento, caixa e nome do meio omitido', async () => {
    expect(await find('lucia dias')).toMatchObject({ status: 'found', guest: { full_name: 'Lúcia Helena Dias', has_phone: false } });
    expect(await find('LÚCIA HELENA DIAS')).toMatchObject({ status: 'found' });
    expect(await find('Ana Paula')).toMatchObject({ status: 'found', guest: { full_name: 'Ana Paula Souza Lima' } });
  });

  it('exige nome e sobrenome, não adivinha e nunca devolve lista', async () => {
    expect(await find('Lúcia')).toEqual({ status: 'need_full_name' });
    expect(await find('João Barbosa')).toMatchObject({ status: 'found', guest: { full_name: 'João Carlos Barbosa' } });
    expect(await find('Sofia Ferreira')).toEqual({ status: 'not_found' });
    expect(await find("'; drop table public.guests; --")).toMatchObject({ status: expect.any(String) });
  });

  it('o primeiro nome também precisa ser parecido: sobrenome sozinho não acha ninguém', async () => {
    // Caso real: "Caio Valadares" empatava entre Calebe e Abel só pelo sobrenome em comum.
    await importGuests([
      ...GUESTS,
      { household: 'Família Caio', full_name: 'Caio Prado' },
      { household: 'Família Esteves', full_name: 'Calebe Valadares' },
      { household: 'Família Monteiro', full_name: 'Abel Valadares' },
      { household: 'Família Monteiro', full_name: 'Karla Valadares' },
      { household: 'Família Mendes', full_name: 'Thiago Mendes' },
    ]);
    expect(await find('Caio Valadares')).toEqual({ status: 'not_found' });
    expect(await find('Calebe Valadares')).toMatchObject({ status: 'found', guest: { full_name: 'Calebe Valadares' } });
    expect(await find('Kaio Prado')).toMatchObject({ status: 'found', guest: { full_name: 'Caio Prado' } });
    expect(await find('Tiago Mendes')).toMatchObject({ status: 'found', guest: { full_name: 'Thiago Mendes' } });
    expect(await find('Carla Valadares')).toMatchObject({ status: 'found', guest: { full_name: 'Karla Valadares' } });
    expect(await find('Joana Souza')).toEqual({ status: 'not_found' });
  });

  it('mesmo primeiro nome e nomes parecidos: continua pedindo o nome completo', async () => {
    await importGuests([
      ...GUESTS,
      { household: 'Família Caio', full_name: 'Caio Valadares Prado' },
      { household: 'Família Tavares', full_name: 'Caio Valadares Tavares' },
    ]);
    expect(await find('Caio Valadares')).toEqual({ status: 'ambiguous' });
    expect(await find('Caio Valadares Prado')).toMatchObject({ status: 'found', guest: { full_name: 'Caio Valadares Prado' } });
  });

  it('nome longo é achado pelo nome curto, se for uma pessoa só', async () => {
    // Com o nome completo na lista, "Roberta Prado" ficava abaixo da nota mínima.
    await importGuests([
      ...GUESTS,
      { household: 'Família Barbosa', full_name: 'Roberta Valadares Tavares Prado' },
      { household: 'Família Monteiro', full_name: 'Cesar Augusto de Almeida Monteiro' },
      { household: 'Família Cunha', full_name: 'Rafaely Cunha Teles' },
      { household: 'Família Monteiro', full_name: 'Rafael Teles Rocha' },
      { household: 'Família Bastos', full_name: 'Ana Clara Bastos' },
      { household: 'Família Bastos', full_name: 'Ana Paula Bastos' },
    ]);
    expect(await find('Roberta Prado')).toMatchObject({ status: 'found', guest: { full_name: 'Roberta Valadares Tavares Prado' } });
    expect(await find('Roberta Tavares Prado')).toMatchObject({ status: 'found', guest: { full_name: 'Roberta Valadares Tavares Prado' } });
    expect(await find('Cesar Monteiro')).toMatchObject({ status: 'found', guest: { full_name: 'Cesar Augusto de Almeida Monteiro' } });
    expect(await find('César Almeida')).toMatchObject({ status: 'found', guest: { full_name: 'Cesar Augusto de Almeida Monteiro' } });
    // Primeiro nome igual vence o parecido (Rafaely × Rafael).
    expect(await find('Rafaely Teles')).toMatchObject({ status: 'found', guest: { full_name: 'Rafaely Cunha Teles' } });
    expect(await find('Rafael Teles')).toMatchObject({ status: 'found', guest: { full_name: 'Rafael Teles Rocha' } });
    expect(await find('Kaio Prado')).toEqual({ status: 'not_found' });
    // Duas pessoas cabem no nome curto: pede o nome completo.
    expect(await find('Ana Bastos')).toEqual({ status: 'ambiguous' });
    expect(await find('Ana Paula Bastos')).toMatchObject({ status: 'found', guest: { full_name: 'Ana Paula Bastos' } });
    // Erro de grafia no sobrenome ainda passa pela nota.
    expect(await find('Roberta Valadares Tavares Pradoa')).toMatchObject({ status: 'found' });
  });

  it('quem tem outro telefone na lista não pode ser assumido pelo nome', async () => {
    const r = await find('Carlos Souza');
    expect(r).toMatchObject({ status: 'found', guest: { has_phone: true } });
    expect(await link(DESCONHECIDO, r.guest.id)).toMatchObject({ ok: false, error: 'has_other_phone' });
  });

  it('o vinculado pelo nome responde só por si e não vê a família', async () => {
    const ana = await guestId('Ana Paula Souza Lima');
    expect(await link(DESCONHECIDO, ana)).toMatchObject({ ok: true, full_name: 'Ana Paula Souza Lima' });

    const s = await bot('public.bot_household_status($1)', [DESCONHECIDO]);
    expect(s).toMatchObject({ identified: true, verified_by: 'name', household: null });
    expect(s.members.map((m: Json) => m.full_name)).toEqual(['Ana Paula Souza Lima']);

    expect(await setRsvp(DESCONHECIDO, ['Pedro Souza'], 'attending')).toMatchObject({ ok: false, error: 'not_allowed' });
    expect(await setRsvp(DESCONHECIDO, ['Ana Paula Souza Lima'], 'attending')).toMatchObject({ ok: true });
  });

  it('um convidado só fica vinculado a um contato, e telefone da lista não troca de identidade', async () => {
    const lucia = await guestId('Lúcia Helena Dias');
    expect(await link(DESCONHECIDO, lucia)).toMatchObject({ ok: true });
    expect(await link(OUTRO, lucia)).toMatchObject({ ok: false, error: 'linked_to_other_contact' });
    expect(await link(CARLOS, lucia)).toMatchObject({ ok: false, error: 'already_identified' });
  });
});

describe('relatório', () => {
  it('conta por situação e agrupa por família', async () => {
    await setRsvp(CARLOS, ['Carlos Souza', 'Pedro Souza'], 'attending');
    await setRsvp(JOAO, ['Joana Barbosa'], 'declined');
    const r = await bot('public.bot_report()');
    expect(r.totals).toEqual({ guests: 8, attending: 2, declined: 1, pending: 5, attending_minors: 1 });
    expect(r.households.map((h: Json) => h.label)).toEqual(['Família Barbosa', 'Família Souza', 'Vovó Lúcia']);
    const souza = r.households.find((h: Json) => h.label === 'Família Souza');
    expect(souza.members.find((m: Json) => m.full_name === 'Pedro Souza')).toMatchObject({ is_minor: true, rsvp_status: 'attending' });
  });
});

describe('inbox, trava e tetos de uso', () => {
  const add = (id: string, phone = DESCONHECIDO) =>
    bot('public.bot_inbox_add($1, $2, $3, $4, $5)', [id, phone, '  Dona Lúcia ', 'text', 'Oi!']);

  it('o inbox é idempotente pelo id da mensagem e cria o contato', async () => {
    expect(await add('m1')).toMatchObject({ inserted: true });
    expect(await add('m1')).toMatchObject({ inserted: false, id: null });
    await add('m2');
    const pending = await bot<Json[]>('public.bot_inbox_pending($1)', [DESCONHECIDO]);
    expect(pending.map((m) => m.wa_message_id)).toEqual(['m1', 'm2']);
    const contact = await db.query<Json>('select display_name from public.wa_contacts where phone = $1', [DESCONHECIDO]);
    expect(contact.rows[0]!.display_name).toBe('Dona Lúcia');

    await bot('public.bot_inbox_done($1::bigint[])', [pending.map((m) => m.id)]);
    expect(await bot('public.bot_inbox_pending($1)', [DESCONHECIDO])).toEqual([]);
  });

  it('só um processamento por telefone de cada vez', async () => {
    await add('m1');
    expect(await bot('public.bot_claim_contact($1)', [DESCONHECIDO])).toBe(true);
    expect(await bot('public.bot_claim_contact($1)', [DESCONHECIDO])).toBe(false);
    await bot('public.bot_release_contact($1)', [DESCONHECIDO]);
    expect(await bot('public.bot_claim_contact($1)', [DESCONHECIDO])).toBe(true);
    // Trava vencida (worker que caiu) pode ser retomada.
    await db.exec(`update public.wa_contacts set lease_until = now() - interval '1 second'`);
    expect(await bot('public.bot_claim_contact($1)', [DESCONHECIDO])).toBe(true);
  });

  it('aplica o teto diário por telefone e o global', async () => {
    await add('m1');
    await add('m2', OUTRO);
    await db.exec('update public.rsvp_settings set turns_per_phone_per_day = 2, turns_per_day = 3 where id = 1');
    const turn = (p: string) => bot('public.bot_consume_turn($1)', [p]);
    expect(await turn(DESCONHECIDO)).toEqual({ allowed: true });
    expect(await turn(DESCONHECIDO)).toEqual({ allowed: true });
    expect(await turn(DESCONHECIDO)).toEqual({ allowed: false, reason: 'phone_limit' });
    expect(await turn(OUTRO)).toEqual({ allowed: true });
    expect(await turn(OUTRO)).toEqual({ allowed: false, reason: 'global_limit' });
    expect(await turn(CARLOS)).toEqual({ allowed: false, reason: 'unknown_contact' });
    // No dia seguinte o contador do telefone recomeça.
    await db.exec(`update public.wa_contacts set turns_day = turns_day - 1; delete from public.bot_usage`);
    expect(await turn(DESCONHECIDO)).toEqual({ allowed: true });
  });
});

describe('memória', () => {
  beforeEach(async () => {
    await bot('public.bot_inbox_add($1, $2, $3, $4, $5)', ['m0', DESCONHECIDO, 'Lúcia', 'text', 'Oi']);
  });

  it('guarda o histórico append-only, com blocos de raciocínio intactos', async () => {
    let mem = await bot('public.bot_load_memory($1)', [DESCONHECIDO]);
    expect(mem).toMatchObject({ contact: { is_first_conversation: true }, session: null, summaries: [], notes: [] });

    const session = await bot<string>('public.bot_open_session($1)', [DESCONHECIDO]);
    expect(await bot('public.bot_open_session($1)', [DESCONHECIDO])).toBe(session);
    const messages = [
      { role: 'user', content: 'Oi, quero confirmar' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '...', signature: 'abc' }, { type: 'text', text: 'Olá!' }] },
    ];
    await bot('public.bot_append_messages($1::uuid, $2::jsonb, true)', [session, JSON.stringify(messages)]);

    mem = await bot('public.bot_load_memory($1)', [DESCONHECIDO]);
    expect(mem.session).toMatchObject({ id: session, turns: 1, messages });
    expect(mem.contact.is_first_conversation).toBe(false);

    await expect(db.exec(`update public.wa_session_messages set content = '"x"'`)).rejects.toThrow(/append_only/);
  });

  it('encerra com resumo, abre outra sessão e lembra dos resumos', async () => {
    const s1 = await bot<string>('public.bot_open_session($1)', [DESCONHECIDO]);
    await bot('public.bot_append_messages($1::uuid, $2::jsonb, true)', [s1, JSON.stringify([{ role: 'user', content: 'Tem estacionamento?' }])]);
    await bot('public.bot_close_session($1::uuid, $2)', [s1, 'Perguntou sobre estacionamento.']);
    await expect(
      bot('public.bot_append_messages($1::uuid, $2::jsonb)', [s1, JSON.stringify([{ role: 'user', content: 'x' }])]),
    ).rejects.toThrow(/session_closed/);

    const s2 = await bot<string>('public.bot_open_session($1)', [DESCONHECIDO]);
    expect(s2).not.toBe(s1);
    const mem = await bot('public.bot_load_memory($1)', [DESCONHECIDO]);
    expect(mem.session).toMatchObject({ id: s2, messages: [] });
    expect(mem.summaries.map((x: Json) => x.summary)).toEqual(['Perguntou sobre estacionamento.']);
  });

  it('anota fatos duradouros com limite e sem duplicar, e guarda o nome preferido', async () => {
    const note = (n: string) => bot('public.bot_add_note($1, $2)', [DESCONHECIDO, n]);
    expect(await note('Prefere ser chamada de Dona Lúcia')).toEqual({ ok: true });
    expect(await note('Prefere ser chamada de Dona Lúcia')).toEqual({ ok: true });
    expect(await note('   ')).toEqual({ ok: false, error: 'invalid_note' });
    for (let i = 1; i < 20; i++) await note(`nota ${i}`);
    expect(await note('nota 21')).toEqual({ ok: false, error: 'too_many_notes' });

    expect(await bot('public.bot_set_preferred_name($1, $2)', [DESCONHECIDO, 'Dona Lúcia'])).toEqual({ ok: true });
    const mem = await bot('public.bot_load_memory($1)', [DESCONHECIDO]);
    expect(mem.notes).toHaveLength(20);
    expect(mem.contact.preferred_name).toBe('Dona Lúcia');
  });

  it('a memória de um contato não aparece para outro', async () => {
    await bot('public.bot_add_note($1, $2)', [DESCONHECIDO, 'segredo']);
    await bot('public.bot_inbox_add($1, $2, $3, $4)', ['m9', OUTRO, null, 'text']);
    expect((await bot('public.bot_load_memory($1)', [OUTRO])).notes).toEqual([]);
  });

  it('a limpeza da LGPD apaga conversas e memória, mas mantém a lista e as respostas', async () => {
    await setRsvp(CARLOS, ['Carlos Souza'], 'attending');
    await bot('public.bot_add_note($1, $2)', [DESCONHECIDO, 'nota']);
    expect(await bot('public.bot_purge_conversations()')).toEqual({ contacts_deleted: 1 });
    for (const t of ['wa_contacts', 'wa_inbox', 'wa_sessions', 'wa_session_messages', 'contact_notes']) {
      const n = await db.query<{ n: number }>(`select count(*)::int as n from public.${t}`);
      expect(n.rows[0]!.n, t).toBe(0);
    }
    expect(await status('Carlos Souza')).toBe('attending');
    const ev = await db.query<Json>('select origin_phone from public.rsvp_events');
    expect(ev.rows).toEqual([{ origin_phone: null }]);
  });
});

describe('recados para a Sofia', () => {
  const save = (phone: string, body: string, signature: string | null = null, source = 'text') =>
    bot('public.bot_save_guest_message($1, $2, $3, $4, $5)', [phone, body, signature, source, 'wamid-r']);
  const messages = () => bot<Json[]>('public.bot_guest_messages()');

  it('quem não está na lista não deixa recado', async () => {
    expect(await save(DESCONHECIDO, 'Parabéns!')).toEqual({ ok: false, error: 'not_identified' });
    expect(await messages()).toEqual([]);
  });

  it('valida tamanho do texto, da assinatura e a origem', async () => {
    expect(await save(CARLOS, '   ')).toEqual({ ok: false, error: 'invalid_message' });
    expect(await save(CARLOS, 'x'.repeat(1001))).toEqual({ ok: false, error: 'invalid_message' });
    expect(await save(CARLOS, 'Oi', 'y'.repeat(81))).toEqual({ ok: false, error: 'invalid_signature' });
    expect(await save(CARLOS, 'Oi', null, 'video')).toEqual({ ok: false, error: 'invalid_source' });
    expect(await save(CARLOS, 'x'.repeat(1000), 'y'.repeat(80))).toMatchObject({ ok: true });
  });

  it('um recado por pessoa: mandar de novo substitui, mantendo os parágrafos', async () => {
    expect(await save(CARLOS, 'Primeiro recado')).toEqual({ ok: true, replaced: false, full_name: 'Carlos Souza' });
    expect(await save(CARLOS, '  Feliz 15 anos,   Sofia!\n\nCom carinho.  ', ' Tio  Carlos e Marta ', 'audio')).toEqual({
      ok: true,
      replaced: true,
      full_name: 'Carlos Souza',
    });
    expect(await messages()).toEqual([
      expect.objectContaining({
        full_name: 'Carlos Souza',
        household: 'Família Souza',
        signature: 'Tio Carlos e Marta',
        body: 'Feliz 15 anos, Sofia!\n\nCom carinho.',
        source: 'audio',
      }),
    ]);
  });

  it('a situação da família mostra o texto só a quem pode trocar o recado', async () => {
    await save(CARLOS, 'Recado do Carlos');
    const member = async (phone: string, name: string) =>
      ((await bot('public.bot_household_status($1)', [phone])).members as Json[]).find((m) => m.full_name === name)!;
    expect((await member(CARLOS, 'Carlos Souza')).message).toMatchObject({
      can_change: true,
      written_by_you: true,
      written_by_owner: true,
      body: 'Recado do Carlos',
    });
    // A Marta (mesma família) vê que existe, sem o texto.
    expect((await member(MARTA, 'Carlos Souza')).message).toEqual({ can_change: false, written_by_you: false, written_by_owner: true });
    expect((await member(BIA, 'Bia Souza')).message).toBeNull();
    expect(await bot('public.bot_household_status($1)', [DESCONHECIDO])).not.toHaveProperty('members');
  });

  describe('recados pela família', () => {
    const saveFor = (phone: string, body: string, forName: string, signature: string | null = null) =>
      guestId(forName).then((id) =>
        bot('public.bot_save_guest_message($1, $2, $3, $4, $5, $6::uuid)', [phone, body, signature, 'text', 'wamid-f', id]),
      );

    it('o responsável deixa recado por qualquer membro: no máximo um por pessoa', async () => {
      expect(await saveFor(CARLOS, 'Do Pedro', 'Pedro Souza')).toEqual({ ok: true, replaced: false, full_name: 'Pedro Souza' });
      expect(await saveFor(CARLOS, 'Da família toda', 'Ana Paula Souza Lima', 'Família Souza')).toMatchObject({ ok: true });
      expect(await save(CARLOS, 'Só meu')).toMatchObject({ ok: true, full_name: 'Carlos Souza' });
      expect(await saveFor(CARLOS, 'Da Marta', 'Marta Souza')).toMatchObject({ ok: true });
      expect(await saveFor(CARLOS, 'Da Bia', 'Bia Souza')).toMatchObject({ ok: true });
      expect(await saveFor(CARLOS, 'Do Pedro, de novo', 'Pedro Souza')).toMatchObject({ ok: true, replaced: true });
      const rows = await db.query<{ n: number }>(`select count(*)::int as n from public.guest_messages`);
      expect(rows.rows[0]!.n).toBe(5);
      expect((await messages()).find((m) => m.full_name === 'Pedro Souza')).toMatchObject({
        body: 'Do Pedro, de novo',
        sent_by: 'Carlos Souza',
      });
      expect((await messages()).find((m) => m.full_name === 'Carlos Souza')).toMatchObject({ sent_by: null });
    });

    it('outro responsável não troca o recado escrito por outra pessoa', async () => {
      await saveFor(CARLOS, 'Do Pedro, pelo pai', 'Pedro Souza');
      expect(await saveFor(MARTA, 'Do Pedro, pela mãe', 'Pedro Souza')).toEqual({
        ok: false,
        error: 'message_owned',
        full_name: 'Pedro Souza',
      });
      // Nem o recado que a própria Marta gravou o Carlos troca.
      await save(MARTA, 'Da Marta');
      expect(await saveFor(CARLOS, 'Troca', 'Marta Souza')).toMatchObject({ ok: false, error: 'message_owned' });
    });

    it('o dono troca o recado escrito por ele; depois disso, só ele', async () => {
      await saveFor(CARLOS, 'Da Bia, pelo pai', 'Bia Souza');
      expect(await save(BIA, 'Da Bia, por ela')).toMatchObject({ ok: true, replaced: true });
      expect(await saveFor(CARLOS, 'Pelo pai de novo', 'Bia Souza')).toMatchObject({ ok: false, error: 'message_owned' });
      expect((await messages())[0]).toMatchObject({ full_name: 'Bia Souza', body: 'Da Bia, por ela', sent_by: null });
    });

    it('quem não responde pela família deixa só o próprio; outra família, nunca', async () => {
      expect(await saveFor(BIA, 'Pelo irmão', 'Pedro Souza')).toEqual({ ok: false, error: 'not_allowed' });
      expect(await saveFor(CARLOS, 'Para a Joana', 'Joana Barbosa')).toEqual({ ok: false, error: 'not_in_household' });
      // Vinculado pelo nome: só por si.
      await bot('public.bot_link_contact($1, $2::uuid)', [DESCONHECIDO, await guestId('Joana Barbosa')]);
      expect(await saveFor(DESCONHECIDO, 'Pelo João', 'João Carlos Barbosa')).toEqual({ ok: false, error: 'not_allowed' });
      expect(await messages()).toEqual([]);
    });

    it('trocar o recado pela família também o devolve à fila do Salão', async () => {
      await saveFor(CARLOS, 'Do Pedro', 'Pedro Souza');
      const [m] = await messages();
      await bot('public.bot_set_message_approval($1, $2)', [m!.id, true]);
      await saveFor(CARLOS, 'Do Pedro, novo', 'Pedro Souza');
      expect((await messages())[0]).toMatchObject({ approved: false });
    });
  });

  it('o vinculado pelo nome deixa recado em nome próprio', async () => {
    const lucia = await guestId('Lúcia Helena Dias');
    await bot('public.bot_link_contact($1, $2::uuid)', [DESCONHECIDO, lucia]);
    expect(await save(DESCONHECIDO, 'Da vovó, com amor')).toMatchObject({ ok: true });
    expect((await messages())[0]).toMatchObject({ full_name: 'Lúcia Helena Dias', household: 'Vovó Lúcia' });
  });

  it('ocultos saem da lista e do relatório; a limpeza da LGPD preserva os recados', async () => {
    await save(CARLOS, 'Recado 1');
    await save(JOAO, 'Recado 2');
    expect((await messages()).map((m) => m.full_name)).toEqual(['Carlos Souza', 'João Carlos Barbosa']);
    expect((await bot('public.bot_report()')).messages).toEqual({ total: 2, last_24h: 2, awaiting_approval: 2 });

    await db.exec(`update public.guest_messages set hidden = true where guest_id = (select id from public.guests where full_name = 'João Carlos Barbosa')`);
    expect((await messages()).map((m) => m.full_name)).toEqual(['Carlos Souza']);
    expect((await bot('public.bot_report()')).messages).toEqual({ total: 1, last_24h: 1, awaiting_approval: 1 });

    await bot('public.bot_purge_conversations()');
    const n = await db.query<{ n: number }>('select count(*)::int as n from public.guest_messages');
    expect(n.rows[0]!.n).toBe(2);
  });
});

describe('O Salão Principal (recados no site)', () => {
  const save = (phone: string, body: string, signature: string | null = null) =>
    bot('public.bot_save_guest_message($1, $2, $3, $4, $5)', [phone, body, signature, 'text', 'wamid-s']);
  const list = () => bot<Json[]>('public.bot_guest_messages()');
  const approve = (id: number, approved = true) => bot('public.bot_set_message_approval($1, $2)', [id, approved]);
  const wall = () => bot<Json>('public.bot_site_messages()');
  const unseal = (at: string) => db.exec(`update public.message_wall_settings set unseal_at = '${at}' where id = 1`);

  it('nada aparece no site sem aprovação; a lista mostra número e estado', async () => {
    await save(CARLOS, 'Feliz 15 anos!', 'Tio Carlos');
    const [m] = await list();
    expect(m).toMatchObject({ approved: false, id: expect.any(Number) });
    expect(await wall()).toMatchObject({ sealed: true, letters: [] });

    expect(await approve(m!.id)).toEqual({ ok: true, approved: true, from: 'Tio Carlos' });
    expect((await list())[0]).toMatchObject({ approved: true });
    expect((await bot('public.bot_report()')).messages.awaiting_approval).toBe(0);
  });

  it('selada antes da festa: o texto não sai do banco, só quem enviou', async () => {
    await save(CARLOS, 'Segredo até a festa', 'Tio Carlos');
    await save(JOAO, 'Sem assinatura');
    for (const m of await list()) await approve(m.id);

    const sealed = await wall();
    expect(sealed.sealed).toBe(true);
    expect(sealed.letters).toEqual([
      { id: expect.stringMatching(/^[0-9a-f-]{36}$/), from: 'Tio Carlos' },
      { id: expect.any(String), from: 'João' },
    ]);
    expect(JSON.stringify(sealed)).not.toMatch(/Segredo|Barbosa|Souza/);

    await unseal('2000-01-01 00:00:00+00');
    const open = await wall();
    expect(open.sealed).toBe(false);
    expect(open.letters.map((l: Json) => l.body)).toEqual(['Segredo até a festa', 'Sem assinatura']);
  });

  it('retirar, ocultar ou trocar o texto tira a carta do Salão', async () => {
    await save(CARLOS, 'Primeira versão');
    await save(JOAO, 'Recado do João');
    const [carlos, joao] = await list();
    await approve(carlos!.id);
    await approve(joao!.id);
    expect((await wall()).letters).toHaveLength(2);

    expect(await approve(joao!.id, false)).toMatchObject({ ok: true, approved: false });
    expect((await wall()).letters).toHaveLength(1);

    // Trocar o texto devolve à fila; reenviar o mesmo texto mantém a aprovação.
    await save(CARLOS, 'Segunda versão');
    expect((await wall()).letters).toHaveLength(0);
    expect((await list())[0]).toMatchObject({ body: 'Segunda versão', approved: false });
    await approve(carlos!.id);
    await save(CARLOS, 'Segunda versão');
    expect((await wall()).letters).toHaveLength(1);

    await db.exec(`update public.guest_messages set hidden = true where id = ${carlos!.id}`);
    expect((await wall()).letters).toHaveLength(0);
    expect(await approve(carlos!.id)).toEqual({ ok: false, error: 'hidden' });
    expect(await approve(999999)).toEqual({ ok: false, error: 'not_found' });
  });

  it('o id público é opaco e estável', async () => {
    await save(CARLOS, 'Oi');
    const [m] = await list();
    await approve(m!.id);
    const before = (await wall()).letters[0].id;
    await approve(m!.id);
    expect((await wall()).letters[0].id).toBe(before);
    expect(before).not.toBe(String(m!.id));
  });
});

describe('pedidos de identidade (autoridade dos organizadores)', () => {
  const ADMIN = '5527900001111'; // organizador fictício
  const contact = (phone: string, id = `m-${phone}`) =>
    bot('public.bot_inbox_add($1, $2, $3, $4, $5)', [id, phone, 'Fulano', 'text', 'Oi']);
  const request = (phone: string, name: string, guest: string | null = null) =>
    bot('public.bot_request_identity($1, $2, $3::uuid)', [phone, name, guest]);
  const resolve = (id: number, accept: boolean, name: string | null = null) =>
    bot('public.bot_resolve_identity_request($1, $2, $3, $4)', [id, accept, ADMIN, name]);
  const actor = async (phone: string) =>
    (await as<Json>('service_role', 'select * from public.bot_actor($1)', [phone]))[0] ?? null;
  const phoneOf = async (name: string) =>
    (await db.query<Json>('select phone_e164 from public.guests where full_name = $1', [name])).rows[0]!.phone_e164;

  it('abre o pedido com o convidado sugerido; o mesmo número não abre outro enquanto está pendente', async () => {
    await contact(DESCONHECIDO);
    const r = await request(DESCONHECIDO, '  Carlos   Souza ', await guestId('Carlos Souza'));
    expect(r).toMatchObject({
      ok: true, created: true, phone: DESCONHECIDO, claimed_name: 'Carlos Souza', display_name: 'Fulano',
      guest_name: 'Carlos Souza', household: 'Família Souza', guest_phone: '+5531988887777',
    });
    expect(await request(DESCONHECIDO, 'Carlos Souza')).toEqual({ ok: true, created: false, id: r.id });
    expect(await bot('public.bot_identity_request_status($1)', [DESCONHECIDO])).toMatchObject({
      id: r.id, status: 'pending', claimed_name: 'Carlos Souza', resolved_at: null,
    });
    expect(await bot('public.bot_identity_request_status($1)', [OUTRO])).toBeNull();
  });

  it('recusa contato inexistente, número já identificado e nome inválido', async () => {
    expect(await request(OUTRO, 'Carlos Souza')).toEqual({ ok: false, error: 'unknown_contact' });
    await contact(CARLOS_SEM_9);
    expect(await request(CARLOS_SEM_9, 'Marta Souza')).toEqual({ ok: false, error: 'already_identified' });
    await contact(DESCONHECIDO);
    expect(await request(DESCONHECIDO, 'x')).toEqual({ ok: false, error: 'invalid_name' });
  });

  it('aceitar troca o telefone do convidado: o número novo responde pela família', async () => {
    await contact(DESCONHECIDO);
    const { id } = await request(DESCONHECIDO, 'Carlos Souza', await guestId('Carlos Souza'));
    const r = await resolve(id, true);
    expect(r).toMatchObject({
      ok: true, status: 'accepted', phone: DESCONHECIDO, guest_name: 'Carlos Souza', household: 'Família Souza',
      previous_phone: '+5531988887777',
    });
    expect(await phoneOf('Carlos Souza')).toBe('+5511912345678');
    expect(await actor(DESCONHECIDO)).toMatchObject({ verified_by: 'phone', can_answer_for_household: true });
    expect(await actor(CARLOS)).toBeNull(); // o número antigo (errado) deixou de valer
    expect(await setRsvp(DESCONHECIDO, ['Carlos Souza', 'Pedro Souza'], 'attending')).toMatchObject({ ok: true });
    const audit = (await db.query<Json>('select status, resolved_by, previous_phone from public.identity_requests')).rows;
    expect(audit).toEqual([{ status: 'accepted', resolved_by: ADMIN, previous_phone: '+5531988887777' }]);
  });

  it('o número que chega sem o 9 é gravado com o 9, como na importação', async () => {
    const semNove = '552788887777';
    await contact(semNove);
    const { id } = await request(semNove, 'Joana Barbosa');
    await resolve(id, true, 'Joana Barbosa');
    expect(await phoneOf('Joana Barbosa')).toBe('+5527988887777');
    expect(await actor(semNove)).toMatchObject({ verified_by: 'phone' });
    expect(await actor('5527988887777')).toMatchObject({ verified_by: 'phone' });
  });

  it('nome não encontrado: o organizador indica o convidado; vínculo por nome de outro número cai', async () => {
    await contact(OUTRO);
    await bot('public.bot_link_contact($1, $2::uuid)', [OUTRO, await guestId('Joana Barbosa')]);
    await contact(DESCONHECIDO);
    const { id } = await request(DESCONHECIDO, 'Jô Barbosa');
    expect(await resolve(id, true)).toEqual({ ok: false, error: 'need_guest_name', claimed_name: 'Jô Barbosa' });
    expect(await resolve(id, true, 'Fulano de Tal')).toEqual({ ok: false, error: 'guest_not_found' });
    expect(await resolve(id, true, 'Souza')).toEqual({ ok: false, error: 'guest_need_full_name' });
    expect(await resolve(id, true, 'joana barbosa')).toMatchObject({ ok: true, guest_name: 'Joana Barbosa', previous_phone: null });
    expect(await actor(DESCONHECIDO)).toMatchObject({ verified_by: 'phone' });
    expect(await actor(OUTRO)).toBeNull();
  });

  it('sugere aos organizadores os nomes mais parecidos da lista, só quando são parecidos', async () => {
    const suggest = (name: string | null, limit?: number) =>
      bot('public.bot_suggest_guest_names($1, coalesce($2::integer, 3))', [name, limit ?? null]);
    expect(await suggest('Jô Barbosa')).toEqual([
      { full_name: 'Joana Barbosa', household: 'Família Barbosa' },
      { full_name: 'João Carlos Barbosa', household: 'Família Barbosa' },
    ]);
    expect(await suggest('lucia dias')).toEqual([{ full_name: 'Lúcia Helena Dias', household: 'Vovó Lúcia' }]);
    expect(await suggest('Souza')).toHaveLength(3);
    expect(await suggest('Souza', 99)).toHaveLength(5);
    expect(await suggest('Fulano de Tal')).toEqual([]);
    expect(await suggest('')).toEqual([]);
    expect(await suggest(null)).toEqual([]);
  });

  it('recusar encerra o pedido; o número não abre outro; decidir de novo não muda nada', async () => {
    await contact(DESCONHECIDO);
    const { id } = await request(DESCONHECIDO, 'Carlos Souza', await guestId('Carlos Souza'));
    expect(await resolve(id, false)).toEqual({ ok: true, status: 'rejected', phone: DESCONHECIDO, claimed_name: 'Carlos Souza' });
    expect(await phoneOf('Carlos Souza')).toBe('+5531988887777');
    expect(await resolve(id, true)).toEqual({ ok: false, error: 'already_resolved', status: 'rejected', guest_name: null });
    expect(await request(DESCONHECIDO, 'Carlos Souza')).toEqual({ ok: false, error: 'rejected' });
    expect(await resolve(999999, true)).toEqual({ ok: false, error: 'not_found' });
  });

  it('não entrega a outro convidado um número que já é de alguém', async () => {
    await contact(DESCONHECIDO);
    const { id } = await request(DESCONHECIDO, 'Joana Barbosa');
    await db.exec(`update public.guests set phone_e164 = '+5511912345678' where full_name = 'Lúcia Helena Dias'`);
    expect(await resolve(id, true, 'Joana Barbosa')).toEqual({ ok: false, error: 'phone_in_use', other_name: 'Lúcia Helena Dias' });
    expect(await phoneOf('Joana Barbosa')).toBeNull();
  });

  it('no máximo 3 pedidos por número', async () => {
    await contact(DESCONHECIDO);
    for (let i = 0; i < 3; i++) {
      const { id } = await request(DESCONHECIDO, `Pessoa Número ${i}`);
      await db.query(`update public.identity_requests set status = 'accepted' where id = $1`, [id]); // simula decididos
    }
    expect(await request(DESCONHECIDO, 'Mais Uma Pessoa')).toEqual({ ok: false, error: 'too_many_requests' });
  });

  it('reimportar a planilha com o telefone antigo mantém o corrigido (com aviso); telefone novo vale', async () => {
    await contact(DESCONHECIDO);
    const { id } = await request(DESCONHECIDO, 'Carlos Souza', await guestId('Carlos Souza'));
    await resolve(id, true);
    const r = await importGuests(GUESTS);
    expect(r).toMatchObject({ ok: true, applied: true });
    expect(r.warnings).toContain(
      'telefone corrigido pelos organizadores mantido: Carlos Souza — Família Souza (a planilha ainda tem o número antigo)',
    );
    expect(await phoneOf('Carlos Souza')).toBe('+5511912345678');
    const changed = GUESTS.map((g) => (g.full_name === 'Carlos Souza' ? { ...g, phone: '31 98111-2222' } : g));
    expect(await importGuests(changed)).toMatchObject({ ok: true });
    expect(await phoneOf('Carlos Souza')).toBe('+5531981112222');
  });

  it('a limpeza da LGPD apaga os pedidos junto com os contatos', async () => {
    await contact(DESCONHECIDO);
    await request(DESCONHECIDO, 'Carlos Souza');
    await bot('public.bot_purge_conversations()');
    const n = await db.query<{ n: number }>('select count(*)::int as n from public.identity_requests');
    expect(n.rows[0]!.n).toBe(0);
  });
});

describe('pais da Sofia e equipe da festa', () => {
  const ensure = (phone: string, role: string) => bot('public.bot_ensure_special_contact($1, $2)', [phone, role]);
  const household = (phone: string) => bot('public.bot_household_status($1)', [phone]);
  const save = (phone: string, body: string, forGuest: string | null = null) =>
    bot('public.bot_save_guest_message($1, $2, $3, $4, $5, $6::uuid)', [phone, body, 'Assinado', 'text', 'wamid-p', forGuest]);

  it('cria a linha do número fora da lista, uma vez só, e não conta como convidado', async () => {
    const first = await ensure(OUTRO, 'host');
    expect(first).toMatchObject({ ok: true, created: true });
    expect(await ensure(OUTRO, 'host')).toEqual({ ok: true, guest_id: first.guest_id, created: false, changed: false });

    const s = await household(OUTRO);
    expect(s).toMatchObject({ identified: true, role: 'host', verified_by: 'phone', household: 'Família da Sofia (organizadores)' });
    expect(s.members).toEqual([expect.objectContaining({ full_name: 'Pai ou mãe da Sofia', is_you: true, can_answer: true })]);

    const r = await bot('public.bot_report()');
    expect(r.totals.guests).toBe(8);
    expect(r.households.map((h: Json) => h.label)).not.toContain('Família da Sofia (organizadores)');
  });

  it('não confirma presença, mas deixa o próprio recado', async () => {
    const { guest_id } = await ensure(OUTRO, 'staff');
    expect(await bot('public.bot_set_rsvp($1, $2::uuid[], $3)', [OUTRO, [guest_id], 'attending'])).toEqual({
      ok: false,
      error: 'not_a_guest',
    });
    expect(await save(OUTRO, 'Parabéns, Sofia!')).toEqual({ ok: true, replaced: false, full_name: 'Equipe da festa' });
    expect((await household(OUTRO)).household).toBe('Equipe da festa');
  });

  it('quem já está na lista vira pai ou mãe: só vê a si, sem resposta nem recado por ele', async () => {
    expect(await ensure(CARLOS_SEM_9, 'host')).toMatchObject({ ok: true, created: false, changed: true });
    const s = await household(CARLOS);
    expect(s.role).toBe('host');
    expect(s.members.map((m: Json) => m.full_name)).toEqual(['Carlos Souza']);
    expect(await setRsvp(CARLOS, ['Carlos Souza'], 'attending')).toEqual({ ok: false, error: 'not_a_guest' });
    expect(await setRsvp(CARLOS, ['Pedro Souza'], 'attending')).toEqual({ ok: false, error: 'not_a_guest' });

    // Marta responde pela família, mas não por ele.
    const carlos = await guestId('Carlos Souza');
    expect(await setRsvp(MARTA, ['Carlos Souza'], 'attending')).toEqual({ ok: false, error: 'not_a_guest', guest_id: carlos });
    expect(await save(MARTA, 'Recado na vaga dele', carlos)).toEqual({ ok: false, error: 'not_allowed' });
    expect((await household(MARTA)).members.find((m: Json) => m.full_name === 'Carlos Souza').can_answer).toBe(false);
    expect(await save(CARLOS, 'O meu recado')).toMatchObject({ ok: true, full_name: 'Carlos Souza' });

    expect((await bot('public.bot_report()')).totals.guests).toBe(7);
  });

  it('nunca é encontrado pelo nome: só o telefone identifica', async () => {
    await ensure(CARLOS, 'host');
    await ensure(OUTRO, 'staff');
    expect(await bot('public.bot_find_guest_by_name($1)', ['Carlos Souza'])).toEqual({ status: 'not_found' });
    expect(await bot('public.bot_find_guest_by_name($1)', ['Equipe da festa'])).toEqual({ status: 'not_found' });
    const suggested = (await bot<Json[]>('public.bot_suggest_guest_names($1)', ['Carlos Souza'])).map((g) => g.full_name);
    expect(suggested.length).toBeGreaterThan(0);
    expect(suggested).not.toContain('Carlos Souza');
    expect(await bot('public.bot_link_contact($1, $2::uuid)', [DESCONHECIDO, await guestId('Carlos Souza')])).toEqual({
      ok: false,
      error: 'not_found',
    });
  });

  it('valida papel e telefone; reimportar a planilha mantém o papel', async () => {
    expect(await ensure(OUTRO, 'guest')).toEqual({ ok: false, error: 'invalid_role' });
    expect(await ensure('123', 'host')).toEqual({ ok: false, error: 'invalid_phone' });
    await ensure(CARLOS, 'host');
    expect((await importGuests(GUESTS)).errors).toEqual([]);
    expect((await household(CARLOS)).role).toBe('host');
  });
});

describe('isolamento (RLS e privilégios)', () => {
  const TABLES = [
    'households', 'guests', 'rsvp_events', 'rsvp_settings', 'wa_contacts',
    'bot_usage', 'wa_inbox', 'wa_sessions', 'wa_session_messages', 'contact_notes', 'guest_messages',
    'message_wall_settings', 'identity_requests',
  ];

  it('o formulário público antigo não existe mais', async () => {
    const r = await db.query<Json>(
      `select to_regclass('public.rsvps') as t, to_regclass('public.rsvp_latest_responses') as v,
              to_regprocedure('public.submit_rsvp(uuid, text, text, integer, text)') as f`,
    );
    expect(r.rows[0]).toEqual({ t: null, v: null, f: null });
  });

  it('RLS está habilitado em todas as tabelas', async () => {
    const r = await db.query<Json>(
      `select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity`,
    );
    expect(r.rows).toEqual([]);
  });

  it.each(['anon', 'authenticated'])('%s não lê nem escreve tabelas', async (role) => {
    for (const t of TABLES) {
      await expect(as(role, `select * from public.${t}`), t).rejects.toThrow(/permission denied/);
    }
    await expect(as(role, `update public.guests set rsvp_status = 'attending'`)).rejects.toThrow(/permission denied/);
    await expect(as(role, `delete from public.wa_contacts`)).rejects.toThrow(/permission denied/);
  });

  it.each(['anon', 'authenticated'])('%s não executa nenhuma função do projeto', async (role) => {
    const fns = await db.query<{ sig: string }>(
      `select p.oid::regprocedure::text as sig from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'`,
    );
    expect(fns.rows.length).toBeGreaterThan(20);
    const allowed = await db.query<{ sig: string }>(
      `select p.oid::regprocedure::text as sig from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
          and has_function_privilege($1, p.oid, 'execute')`,
      [role],
    );
    expect(allowed.rows.map((r) => r.sig)).toEqual([]);
    await expect(as(role, 'select public.bot_report()')).rejects.toThrow(/permission denied/);
  });

  it('as funções do bot são SECURITY DEFINER com search_path vazio', async () => {
    const r = await db.query<{ sig: string }>(
      `select p.oid::regprocedure::text as sig from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.prosecdef
          and not coalesce(p.proconfig, '{}') @> array['search_path=""']`,
    );
    expect(r.rows).toEqual([]);
  });
});
