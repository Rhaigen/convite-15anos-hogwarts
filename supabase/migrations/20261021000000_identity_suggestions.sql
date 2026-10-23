-- =============================================================================
-- Sugestão de nomes nos pedidos de identidade.
--
-- Quando o nome não é encontrado (no aviso do pedido ou na resposta a
-- "aceitar N Nome"), o organizador recebe os convidados mais parecidos da lista,
-- já no formato do comando. Só o orquestrador chama (service_role): os nomes vão
-- aos organizadores, nunca à Aifos nem a quem escreveu.
-- =============================================================================

create or replace function public.bot_suggest_guest_names(p_name text, p_limit integer default 3)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with q as (select public.normalize_name(left(coalesce(p_name, ''), 120)) as v),
  scored as (
    select g.full_name, h.label as household,
           (extensions.similarity(q.v, g.name_search) + extensions.word_similarity(q.v, g.name_search)) / 2 as score
      from public.guests g
      join public.households h on h.id = g.household_id
      cross join q
     where q.v <> ''
  )
  select coalesce(
    jsonb_agg(jsonb_build_object('full_name', s.full_name, 'household', s.household) order by s.score desc, s.full_name),
    '[]'::jsonb)
    from (
      select * from scored
       where score >= 0.3
       order by score desc, full_name
       limit greatest(1, least(coalesce(p_limit, 3), 5))
    ) s;
$$;

revoke all on function public.bot_suggest_guest_names(text, integer) from public, anon, authenticated;
grant execute on function public.bot_suggest_guest_names(text, integer) to service_role;
