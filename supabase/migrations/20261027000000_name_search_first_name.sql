-- =============================================================================
-- Busca por nome: o primeiro nome também precisa ser parecido.
--
-- Antes, a nota (pg_trgm) somava nome e sobrenome: "Caio Valadares" chegou a
-- empatar entre "Calebe Valadares" e "Abel Valadares" só pelo sobrenome (teste real
-- de 2026-10-22). Agora só entra na disputa quem tem o primeiro nome a até 1 letra
-- de diferença do digitado (2 em nomes com 6 letras ou mais): "Kaio" acha "Caio",
-- "Tiago" acha "Thiago", e um sobrenome sozinho não acha ninguém. Nome exato,
-- nota mínima e empate seguem como antes. Apelido ("Bia" por "Beatriz") não é
-- adivinhado: vira "não encontrado" e a Aifos segue o fluxo de sempre.
-- =============================================================================

create extension if not exists fuzzystrmatch with schema extensions;

create or replace function public.bot_find_guest_by_name(p_name text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_query text := public.normalize_name(p_name);
  v_first text := split_part(public.normalize_name(p_name), ' ', 1);
  v_best record;
  v_exact integer;
begin
  if char_length(v_query) > 120
     or (select count(*) from regexp_split_to_table(v_query, ' ') w where char_length(w) >= 2) < 2 then
    return jsonb_build_object('status', 'need_full_name');
  end if;

  select count(*) into v_exact from public.guests g where g.role = 'guest' and g.name_search = v_query;
  if v_exact > 1 then
    return jsonb_build_object('status', 'ambiguous');
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
