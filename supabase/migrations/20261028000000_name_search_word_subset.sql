-- =============================================================================
-- Busca por nome: nomes longos achados pelo nome curto.
--
-- A nota (pg_trgm) compara o texto inteiro: "Roberta Prado" fica abaixo do
-- mínimo contra "Roberta Valadares Tavares Prado", e dez convidados deixaram de ser
-- achados pelo "primeiro nome + último sobrenome" depois que os sobrenomes foram
-- completados (2026-10-22). Agora, antes da nota: primeiro nome igual e todos os
-- outros nomes digitados presentes no nome da lista, numa pessoa só, é encontrado;
-- mais de uma é ambíguo. Sem ninguém com o primeiro nome igual, vale o mesmo com o
-- primeiro nome parecido (Kaio/Caio). Sem nenhum, segue a nota de antes (erros de
-- grafia no sobrenome).
-- =============================================================================

create or replace function public.bot_find_guest_by_name(p_name text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_query text := public.normalize_name(p_name);
  v_words text[] := regexp_split_to_array(public.normalize_name(p_name), ' ');
  v_first text := split_part(public.normalize_name(p_name), ' ', 1);
  v_best record;
  v_exact integer;
  v_subset record;
begin
  if char_length(v_query) > 120
     or (select count(*) from regexp_split_to_table(v_query, ' ') w where char_length(w) >= 2) < 2 then
    return jsonb_build_object('status', 'need_full_name');
  end if;

  select count(*) into v_exact from public.guests g where g.role = 'guest' and g.name_search = v_query;
  if v_exact > 1 then
    return jsonb_build_object('status', 'ambiguous');
  end if;

  -- Nome curto de um nome longo: os outros nomes digitados estão todos no nome da lista.
  if v_exact = 0 then
    with words as (
      select g.id, g.full_name, g.phone_e164 is not null as has_phone,
             (regexp_split_to_array(g.name_search, ' '))[1] as first,
             (regexp_split_to_array(g.name_search, ' '))[2:] as rest
        from public.guests g
       where g.role = 'guest'
    ),
    subset as (
      select w.*, w.first = v_first as same_first
        from words w
       where v_words[2:] <@ w.rest
         and extensions.levenshtein(v_first, w.first)
             <= case when greatest(char_length(v_first), char_length(w.first)) >= 6 then 2 else 1 end
    ),
    tier as (
      select * from subset s
       where s.same_first or not exists (select 1 from subset x where x.same_first)
    )
    select count(*) as total, min(t.id::text)::uuid as id, min(t.full_name) as full_name, bool_or(t.has_phone) as has_phone
      into v_subset
      from tier t;

    if v_subset.total > 1 then
      return jsonb_build_object('status', 'ambiguous');
    end if;
    if v_subset.total = 1 then
      return jsonb_build_object(
        'status', 'found',
        'guest', jsonb_build_object('id', v_subset.id, 'full_name', v_subset.full_name, 'has_phone', v_subset.has_phone));
    end if;
  end if;

  -- Só disputa quem tem o primeiro nome parecido; o primeiro colocado traz a nota do segundo.
  with candidates as (
    select g.id, g.full_name, g.phone_e164 is not null as has_phone,
           case when g.name_search = v_query then 1.0
                else (extensions.similarity(v_query, g.name_search)
                      + extensions.word_similarity(v_query, g.name_search)) / 2 end as score
      from public.guests g
     where g.role = 'guest'
       and (g.name_search = v_query
            or extensions.levenshtein(v_first, split_part(g.name_search, ' ', 1))
               <= case when greatest(char_length(v_first), char_length(split_part(g.name_search, ' ', 1))) >= 6
                       then 2 else 1 end)
  ),
  ranked as (
    select c.*, row_number() over (order by c.score desc, c.full_name) as position from candidates c
  )
  select r.id, r.full_name, r.has_phone, r.score,
         (select max(o.score) from ranked o where o.position > 1) as second_score
    into v_best
    from ranked r
   where r.position = 1;

  if v_best.id is null or v_best.score < 0.55 then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_best.score < 1.0 and v_best.second_score is not null and v_best.score - v_best.second_score < 0.1 then
    return jsonb_build_object('status', 'ambiguous');
  end if;

  return jsonb_build_object(
    'status', 'found',
    'guest', jsonb_build_object('id', v_best.id, 'full_name', v_best.full_name, 'has_phone', v_best.has_phone));
end;
$$;
