-- =============================================================================
--  Pedidos de identidade: a autoridade dos organizadores
-- =============================================================================
--  Quando um número desconhecido diz ser um convidado que tem OUTRO telefone na
--  lista (número errado na planilha, troca de celular), ou dá um nome que não
--  está na lista, a Aifos abre um pedido numerado e avisa os organizadores
--  (ADMIN_PHONES). Eles respondem pelo WhatsApp, sem IA:
--    "aceitar N"            → o telefone do convidado na lista passa a ser este;
--    "aceitar N Nome Tal"   → idem, para o convidado indicado pelo nome;
--    "recusar N"            → a pessoa é orientada a falar com a família.
--  Quem decide é o código: o organizador é reconhecido pelo telefone no
--  orquestrador; estas funções só gravam e auditam. Ver
--  docs/arquitetura.md#professora-aifos.
--
--  Regras: um pedido pendente por número; no máximo 3 por número; depois de uma
--  recusa, o número não abre outro. LGPD: os pedidos pertencem ao contato e saem
--  com ele em bot_purge_conversations() (cascata de wa_contacts).
-- =============================================================================

create table if not exists public.identity_requests (
  id bigint generated always as identity primary key,
  -- Número como o WhatsApp entrega (só dígitos).
  phone text not null references public.wa_contacts (phone) on delete cascade,
  -- O nome que a pessoa disse ser.
  claimed_name text not null check (char_length(claimed_name) between 2 and 120),
  -- Convidado sugerido pela busca (tem outro telefone); nulo quando o nome não foi encontrado.
  guest_id uuid references public.guests (id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  resolved_guest_id uuid references public.guests (id) on delete set null,
  -- Telefone que o convidado tinha na lista antes de o pedido ser aceito (auditoria e reimportação).
  previous_phone text,
  -- Organizador que decidiu (só dígitos).
  resolved_by text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

comment on table public.identity_requests is
  'Pedidos de identidade decididos pelos organizadores ("aceitar N" / "recusar N" no WhatsApp).';

create unique index if not exists identity_requests_one_pending_idx
  on public.identity_requests (phone) where status = 'pending';
create index if not exists identity_requests_phone_idx on public.identity_requests (phone, created_at desc);
create index if not exists identity_requests_resolved_guest_idx
  on public.identity_requests (resolved_guest_id) where status = 'accepted';

alter table public.identity_requests enable row level security;
revoke all on table public.identity_requests from anon, authenticated;

-- -----------------------------------------------------------------------------
-- Abrir um pedido (chamado pelas ferramentas da Aifos)
-- -----------------------------------------------------------------------------
create or replace function public.bot_request_identity(p_phone text, p_claimed_name text, p_guest_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone text := public.phone_digits(p_phone);
  v_name text := btrim(regexp_replace(coalesce(p_claimed_name, ''), '\s+', ' ', 'g'));
  v_actor record;
  v_existing public.identity_requests%rowtype;
  v_guest_name text;
  v_guest_phone text;
  v_household text;
  v_id bigint;
begin
  if not exists (select 1 from public.wa_contacts c where c.phone = v_phone) then
    return jsonb_build_object('ok', false, 'error', 'unknown_contact');
  end if;
  select * into v_actor from public.bot_actor(v_phone);
  if v_actor.guest_id is not null then
    return jsonb_build_object('ok', false, 'error', 'already_identified');
  end if;
  if char_length(v_name) < 2 or char_length(v_name) > 120 then
    return jsonb_build_object('ok', false, 'error', 'invalid_name');
  end if;

  select * into v_existing from public.identity_requests r where r.phone = v_phone and r.status = 'pending';
  if found then
    return jsonb_build_object('ok', true, 'created', false, 'id', v_existing.id);
  end if;
  if exists (select 1 from public.identity_requests r where r.phone = v_phone and r.status = 'rejected') then
    return jsonb_build_object('ok', false, 'error', 'rejected');
  end if;
  if (select count(*) from public.identity_requests r where r.phone = v_phone) >= 3 then
    return jsonb_build_object('ok', false, 'error', 'too_many_requests');
  end if;

  if p_guest_id is not null then
    select g.full_name, g.phone_e164, h.label
      into v_guest_name, v_guest_phone, v_household
      from public.guests g join public.households h on h.id = g.household_id
     where g.id = p_guest_id;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'not_found');
    end if;
  end if;

  insert into public.identity_requests (phone, claimed_name, guest_id)
  values (v_phone, v_name, p_guest_id)
  returning id into v_id;

  return jsonb_build_object(
    'ok', true,
    'created', true,
    'id', v_id,
    'phone', v_phone,
    'claimed_name', v_name,
    'display_name', (select c.display_name from public.wa_contacts c where c.phone = v_phone),
    'guest_name', v_guest_name,
    'household', v_household,
    'guest_phone', v_guest_phone);
end;
$$;

-- Último pedido do número (para o contexto do turno). Nulo se nunca pediu.
create or replace function public.bot_identity_request_status(p_phone text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id,
    'status', r.status,
    'claimed_name', r.claimed_name,
    'created_at', r.created_at,
    'resolved_at', r.resolved_at)
    from public.identity_requests r
   where r.phone = public.phone_digits(p_phone)
   order by r.created_at desc, r.id desc
   limit 1
$$;

-- -----------------------------------------------------------------------------
-- Decidir um pedido (comandos "aceitar N" / "recusar N" do organizador)
--  Aceitar troca o telefone do convidado na lista pelo número do pedido
--  (normalizado como na importação) e desfaz vínculos por nome de outros números
--  com essa pessoa. O nome informado pelo organizador escolhe (ou troca) o convidado.
-- -----------------------------------------------------------------------------
create or replace function public.bot_resolve_identity_request(
  p_id bigint,
  p_accept boolean,
  p_admin_phone text,
  p_guest_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req public.identity_requests%rowtype;
  v_guest_id uuid;
  v_found jsonb;
  v_guest public.guests%rowtype;
  v_household text;
  v_new_phone text;
  v_conflict text;
  v_name text := nullif(btrim(regexp_replace(coalesce(p_guest_name, ''), '\s+', ' ', 'g')), '');
begin
  select * into v_req from public.identity_requests r where r.id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_req.status <> 'pending' then
    return jsonb_build_object(
      'ok', false,
      'error', 'already_resolved',
      'status', v_req.status,
      'guest_name', (select g.full_name from public.guests g where g.id = v_req.resolved_guest_id));
  end if;

  if not p_accept then
    update public.identity_requests
       set status = 'rejected', resolved_at = now(), resolved_by = public.phone_digits(p_admin_phone)
     where id = v_req.id;
    return jsonb_build_object('ok', true, 'status', 'rejected', 'phone', v_req.phone, 'claimed_name', v_req.claimed_name);
  end if;

  v_guest_id := v_req.guest_id;
  if v_name is not null then
    v_found := public.bot_find_guest_by_name(v_name);
    if v_found ->> 'status' <> 'found' then
      return jsonb_build_object('ok', false, 'error', 'guest_' || (v_found ->> 'status'));
    end if;
    v_guest_id := (v_found -> 'guest' ->> 'id')::uuid;
  end if;
  if v_guest_id is null then
    return jsonb_build_object('ok', false, 'error', 'need_guest_name', 'claimed_name', v_req.claimed_name);
  end if;

  select * into v_guest from public.guests g where g.id = v_guest_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'guest_not_found');
  end if;
  select h.label into v_household from public.households h where h.id = v_guest.household_id;

  v_new_phone := coalesce(
    public.normalize_phone('+' || v_req.phone),
    case when v_req.phone ~ '^[1-9]\d{7,14}$' then '+' || v_req.phone end);
  select g.full_name into v_conflict
    from public.guests g
   where g.id <> v_guest.id and g.phone_e164 = any (public.phone_variants(v_req.phone))
   limit 1;
  if v_conflict is not null then
    return jsonb_build_object('ok', false, 'error', 'phone_in_use', 'other_name', v_conflict);
  end if;

  update public.guests set phone_e164 = v_new_phone where id = v_guest.id;
  -- Um número por pessoa: vínculos por nome de outros contatos com ela deixam de valer.
  update public.wa_contacts set linked_guest_id = null where linked_guest_id = v_guest.id;
  update public.identity_requests
     set status = 'accepted',
         resolved_guest_id = v_guest.id,
         previous_phone = v_guest.phone_e164,
         resolved_at = now(),
         resolved_by = public.phone_digits(p_admin_phone)
   where id = v_req.id;

  return jsonb_build_object(
    'ok', true,
    'status', 'accepted',
    'phone', v_req.phone,
    'claimed_name', v_req.claimed_name,
    'guest_name', v_guest.full_name,
    'household', v_household,
    'previous_phone', v_guest.phone_e164);
end;
$$;

-- -----------------------------------------------------------------------------
-- Importação da planilha: mesma função, com uma regra nova. Se a planilha ainda
-- traz o telefone que um pedido aceito substituiu, o telefone corrigido pelos
-- organizadores fica (com aviso). Telefone novo na planilha continua valendo.
-- -----------------------------------------------------------------------------
create or replace function public.admin_import_guests(p_rows jsonb, p_apply boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_errors jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_row record;
  v_household_id uuid;
  v_inserted integer := 0;
  v_updated integer := 0;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    return jsonb_build_object('ok', false, 'errors', jsonb_build_array('planilha vazia'));
  end if;

  drop table if exists pg_temp.import_rows;
  create temporary table import_rows on commit drop as
  select r.ord::integer as line,
         btrim(regexp_replace(coalesce(r.v ->> 'household', ''), '\s+', ' ', 'g')) as household,
         btrim(regexp_replace(coalesce(r.v ->> 'full_name', ''), '\s+', ' ', 'g')) as full_name,
         public.normalize_name(r.v ->> 'full_name') as name_search,
         nullif(btrim(coalesce(r.v ->> 'phone', '')), '') as phone_raw,
         public.normalize_phone(r.v ->> 'phone') as phone,
         nullif(btrim(coalesce(r.v ->> 'relationship', '')), '') as relationship,
         coalesce((r.v ->> 'is_minor')::boolean, false) as is_minor,
         coalesce((r.v ->> 'can_answer_for_household')::boolean, not coalesce((r.v ->> 'is_minor')::boolean, false))
           as can_answer,
         false as phone_kept
    from jsonb_array_elements(p_rows) with ordinality as r(v, ord);

  -- Telefone corrigido pelos organizadores (pedido aceito): a planilha que ainda
  -- traz o telefone antigo não o desfaz. Telefone diferente do antigo vale.
  update pg_temp.import_rows r
     set phone = g.phone_e164, phone_kept = true
    from public.guests g
    join public.households h on h.id = g.household_id
   where h.label = r.household
     and g.name_search = r.name_search
     and g.phone_e164 is distinct from r.phone
     and exists (
       select 1 from public.identity_requests q
        where q.status = 'accepted'
          and q.resolved_guest_id = g.id
          and q.previous_phone is not distinct from r.phone);

  -- Erros: impedem a importação.
  for v_row in select * from pg_temp.import_rows order by line loop
    if char_length(v_row.household) < 2 then
      v_errors := v_errors || to_jsonb(format('linha %s: família em branco', v_row.line));
    end if;
    if char_length(v_row.full_name) < 2 or char_length(v_row.full_name) > 120 then
      v_errors := v_errors || to_jsonb(format('linha %s: nome inválido', v_row.line));
    end if;
    if v_row.phone_raw is not null and v_row.phone is null then
      v_errors := v_errors || to_jsonb(format('linha %s: telefone inválido (%s)', v_row.line, v_row.phone_raw));
    end if;
    if v_row.is_minor and v_row.can_answer then
      v_errors := v_errors || to_jsonb(format('linha %s: menor de idade não pode responder pela família (%s)', v_row.line, v_row.full_name));
    end if;
  end loop;

  for v_row in
    select phone, string_agg(full_name, ', ' order by line) as names
      from pg_temp.import_rows where phone is not null group by phone having count(*) > 1
  loop
    v_errors := v_errors || to_jsonb(format('telefone repetido %s: %s', v_row.phone, v_row.names));
  end loop;

  for v_row in
    select household, name_search, string_agg(line::text, ', ' order by line) as lines
      from pg_temp.import_rows group by household, name_search having count(*) > 1
  loop
    v_errors := v_errors || to_jsonb(format('nome repetido na mesma família (linhas %s)', v_row.lines));
  end loop;

  for v_row in
    select r.full_name, g.full_name as other_name
      from pg_temp.import_rows r
      join public.guests g on g.phone_e164 = r.phone
      join public.households h on h.id = g.household_id
     where not (h.label = r.household and g.name_search = r.name_search)
  loop
    v_errors := v_errors || to_jsonb(format('telefone de %s já pertence a %s no banco', v_row.full_name, v_row.other_name));
  end loop;

  -- Avisos: não impedem, mas merecem revisão.
  for v_row in select full_name, household from pg_temp.import_rows where phone_kept order by line loop
    v_warnings := v_warnings || to_jsonb(format(
      'telefone corrigido pelos organizadores mantido: %s — %s (a planilha ainda tem o número antigo)',
      v_row.full_name, v_row.household));
  end loop;

  for v_row in
    select household from pg_temp.import_rows group by household
    having not bool_or(phone is not null and can_answer)
  loop
    v_warnings := v_warnings || to_jsonb(format('família sem adulto com telefone: %s (só por busca de nome)', v_row.household));
  end loop;

  for v_row in
    select name_search, string_agg(household, ', ' order by household) as households
      from pg_temp.import_rows group by name_search having count(distinct household) > 1
  loop
    v_warnings := v_warnings || to_jsonb(format('mesmo nome em famílias diferentes (%s): a busca por nome dirá "ambíguo"', v_row.households));
  end loop;

  for v_row in
    select g.full_name, h.label
      from public.guests g join public.households h on h.id = g.household_id
     where not exists (select 1 from pg_temp.import_rows r where r.household = h.label and r.name_search = g.name_search)
  loop
    v_warnings := v_warnings || to_jsonb(format('no banco mas fora da planilha (não foi apagado): %s — %s', v_row.full_name, v_row.label));
  end loop;

  if jsonb_array_length(v_errors) > 0 or not p_apply then
    return jsonb_build_object(
      'ok', jsonb_array_length(v_errors) = 0,
      'applied', false,
      'rows', (select count(*) from pg_temp.import_rows),
      'households', (select count(distinct household) from pg_temp.import_rows),
      'errors', v_errors,
      'warnings', v_warnings);
  end if;

  for v_row in select * from pg_temp.import_rows order by line loop
    insert into public.households (label) values (v_row.household)
    on conflict (label) do update set label = excluded.label
    returning id into v_household_id;

    update public.guests
       set full_name = v_row.full_name,
           phone_e164 = v_row.phone,
           relationship = v_row.relationship,
           is_minor = v_row.is_minor,
           can_answer_for_household = v_row.can_answer
     where household_id = v_household_id and name_search = v_row.name_search;
    if found then
      v_updated := v_updated + 1;
    else
      insert into public.guests (household_id, full_name, phone_e164, relationship, is_minor, can_answer_for_household)
      values (v_household_id, v_row.full_name, v_row.phone, v_row.relationship, v_row.is_minor, v_row.can_answer);
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'applied', true,
    'rows', v_inserted + v_updated,
    'households', (select count(distinct household) from pg_temp.import_rows),
    'inserted', v_inserted,
    'updated', v_updated,
    'errors', v_errors,
    'warnings', v_warnings);
end;
$$;

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.bot_request_identity(text, text, uuid)',
    'public.bot_identity_request_status(text)',
    'public.bot_resolve_identity_request(bigint, boolean, text, text)',
    'public.admin_import_guests(jsonb, boolean)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end;
$$;
