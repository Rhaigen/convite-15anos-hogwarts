-- O Profeta Diário (docs/arquitetura.md#o-profeta-diario): vídeos mandados à Aifos ganham tipo próprio na fila,
-- para irem ao jornal das fotografias (antes caíam em 'other'). Só amplia a lista de tipos aceitos.
alter table public.wa_inbox drop constraint if exists wa_inbox_kind_check;
alter table public.wa_inbox
  add constraint wa_inbox_kind_check check (kind in ('text', 'audio', 'image', 'video', 'sticker', 'other'));
