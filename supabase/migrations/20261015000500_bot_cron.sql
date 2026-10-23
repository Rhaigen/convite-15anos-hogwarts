-- =============================================================================
--  Tarefas agendadas da Professora Sof.IA (pg_cron + pg_net)
-- =============================================================================
--  • a cada 15 min ("tick"): retoma conversas paradas (das 9h às 21h; o código
--    confere o horário) e reprocessa mensagens esquecidas na fila;
--  • 12:00 UTC = 9h em Brasília ("daily-report"): relatório aos organizadores.
--
--  O pg_cron chama a Edge Function whatsapp-cron com o segredo do Vault
--  (sofia_cron_secret, criado na migração anterior). O endereço das funções
--  também fica no Vault, gravado uma vez no deploy (é específico do projeto):
--    select vault.create_secret('https://<ref>.supabase.co/functions/v1', 'sofia_functions_url');
--
--  Fora do Supabase (PGlite dos testes) não há pg_cron/pg_net: nada é agendado.
-- =============================================================================

create or replace function public.bot_cron_call(p_job text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
  v_request bigint;
begin
  if p_job not in ('tick', 'daily-report') then
    raise exception 'invalid_job' using errcode = '22023';
  end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_url using 'sofia_functions_url';
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_secret using 'sofia_cron_secret';
  if v_url is null or v_secret is null then
    raise warning 'Sof.IA: grave sofia_functions_url e sofia_cron_secret no Vault (job %).', p_job;
    return null;
  end if;

  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 10000)'
     into v_request
    using rtrim(v_url, '/') || '/whatsapp-cron',
          jsonb_build_object('job', p_job),
          jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret);
  return v_request;
end;
$$;

-- Só o dono (postgres, que roda o pg_cron) executa.
revoke all on function public.bot_cron_call(text) from public, anon, authenticated, service_role;

do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron')
     or not exists (select 1 from pg_available_extensions where name = 'pg_net') then
    raise notice 'pg_cron/pg_net indisponíveis: tarefas da Sof.IA não agendadas.';
    return;
  end if;

  create extension if not exists pg_cron with schema pg_catalog;
  create extension if not exists pg_net with schema extensions;

  -- cron.schedule com o mesmo nome substitui o agendamento (idempotente).
  perform cron.schedule('sofia-tick', '*/15 * * * *', $cmd$select public.bot_cron_call('tick')$cmd$);
  perform cron.schedule('sofia-relatorio-diario', '0 12 * * *', $cmd$select public.bot_cron_call('daily-report')$cmd$);
end;
$$;
