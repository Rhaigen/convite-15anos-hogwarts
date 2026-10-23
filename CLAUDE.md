# CLAUDE.md

Guia do projeto para o [Claude Code](https://claude.com/claude-code), usado no desenvolvimento deste
convite. Também serve de referência rápida para quem for mexer no código. Visão geral e instalação
no [README](README.md); detalhes de cada subsistema em [docs/arquitetura.md](docs/arquitetura.md).

## O projeto

Convite digital de 15 anos com tema Harry Potter, um site estático em React + Vite organizado em
capítulos animados. A confirmação de presença não acontece no site: ele leva o convidado até a
**Professora Aifos**, uma agente de IA no WhatsApp (Supabase Edge Functions + Claude), que identifica
cada família pela lista de convidados e grava as respostas. Idioma do projeto: português (código,
comentários, commits e textos).

## Comandos

```bash
npm run dev            # http://localhost:5173
npm run validate       # lint + testes (unitários e SQL) + build + varredura de segredos: rodar antes de concluir
npm run test:e2e       # verificações no Chrome sobre o build de produção (precisa do Chrome instalado)
npm test               # Vitest: tests/*.test.ts
npm run agent:chat     # simulador da Aifos: modelo real + Postgres embutido com convidados fictícios
npm run agent:eval     # 40 cenários da Aifos com o modelo real; rodar depois de mexer no prompt ou nas ferramentas
npm run agent:facts    # regenera, de src/content/, os fatos da Aifos e o catálogo de presentes do servidor
npm run db:schema      # regenera supabase/schema.sql a partir das migrações
npm run photos         # otimiza fotos de fotos-originais/ para public/fotos/ (AVIF + WebP)
npm run deploy:vps     # build + envio do dist/ para a VPS (--voltar desfaz)
```

`.npmrc` tem `legacy-peer-deps=true` (contorna um bug do npm 10 com as peer deps do Vitest): mantenha.
As versões são fixas (save-exact), e o Vitest fica na linha 4.1 de propósito.

## Onde fica cada coisa

- `src/content/`: **todo o conteúdo editável** (data, local, textos, presentes, Pix, fotos, SEO).
  Mudanças de conteúdo vão aqui, nunca nos componentes.
- `src/sections/<Capítulo>/`: um componente por capítulo (`.tsx` + `.css` + coreografia GSAP).
  Ordem: OpeningScene → InvitationLetter → Passage → GryffindorWorld → SofiaGallery → GuestMessage →
  EventDetails → Countdown → RSVP → GiftRegistry → GreatHall → ClosingScene.
- `src/app/`: estado da abertura (`App.tsx`) e capítulos carregados sob demanda (`Journey.tsx`).
- `src/animations/`: registro do GSAP, sequência do envelope, iluminação por cena e revelações.
- `src/lib/`: lógica pura e testada (Pix/BR Code, calendário, contagem, preço dos presentes, etc.).
- `src/profeta/`: página d'O Profeta Diário (segunda entrada do Vite, `profeta/index.html`).
- `supabase/migrations/`: banco (fonte de verdade); `supabase/schema.sql` é o esquema final gerado.
- `supabase/functions/`: Edge Functions. O agente fica em `_shared/agent/` (persona e regras em
  `prompt.ts`, ferramentas em `tools.ts`) e o WhatsApp em `_shared/whatsapp/`.
- `services/profeta/`: serviço de fotos e vídeos (Node 24, sem dependências, ffmpeg).
- `scripts/`: e2e, otimização de imagens, importação de convidados, simulador e avaliação da Aifos, deploy.
- `tests/`: Vitest, inclusive as migrações SQL num Postgres embutido (PGlite).

## Regras do projeto

- **Nunca inventar dados do evento** (horário, endereço, Pix, presentes, textos pessoais). Campo
  desconhecido fica `null` e a interface se adapta.
- **Nenhum sucesso falso:** o site não registra respostas. A Aifos só confirma ao convidado depois que
  o banco aceitou a gravação.
- **Segurança:**
  - nenhuma chave no front;
  - as funções `bot_*` só executam com `service_role`, e `anon`/`authenticated` não têm grant em nada;
  - uma nova operação pública exige função `SECURITY DEFINER` com `search_path = ''`, grants
    explícitos e teste com o papel `anon` em `tests/guests-migration.test.ts`.
- **Dados pessoais nunca entram no repositório:** lista de convidados, telefones, fotos reais e
  recados ficam fora do git (ver `.gitignore`). Testes e cenários usam só pessoas fictícias.
- **Regras do agente que importam ficam no código, não no prompt:**
  - os fatos da festa só chegam pela ferramenta `ver_detalhes_da_festa`, liberada para remetente
    identificado (não voltar os fatos para o prompt);
  - as permissões de resposta são decididas no banco.
- **Animações:**
  - sempre via `useGsapScene(ref, setup, deps)` (`gsap.context` + `revert`);
  - usar `gsap.from`, para que o estado natural do CSS seja visível se a animação falhar;
  - respeitar `reducedMotion`, retornando cedo no setup (o e2e confere que nada fica oculto).
- **Não colocar `transition` de CSS em `opacity`/`transform`** de elementos que o GSAP anima. Para o
  "aperto" de botão, use a propriedade `scale`.
- **Rolagem programática:** `scrollToId()` de `src/lib/scroll.ts`. O `scrollIntoView` suave nativo é
  cancelado pelo `ScrollTrigger.refresh()`.
- **Loops** (velas, partículas, chamas) só rodam com a cena visível e a aba ativa.
- **Pin do ScrollTrigger** só no Capítulo I. Celular e movimento reduzido não podem ter rolagem horizontal.
- `vite.config.ts` importa módulos de `src/content/` e `src/lib/`: esses módulos usam extensão `.ts`
  explícita e não podem usar APIs do navegador.
- **Política de confirmação em dois lugares:** `rsvpConfig` (o que o site exibe) e a tabela
  `rsvp_settings` (fonte de verdade, aplicada pela Aifos). Mudou um, mude o outro.
- **Mudou conteúdo da festa ou da lista de presentes:** `npm run agent:facts` (um teste acusa se esquecer).
- **Mudou o banco:** nova migração em `supabase/migrations/` e `npm run db:schema`. Em produção, o
  `db push` vem sempre depois de um `--dry-run` revisado.

## Fluxo de trabalho

- Uma branch por funcionalidade, com merge `--no-ff` na `main`.
- Antes de concluir: `npm run validate`. Para mudanças visuais, também `npm run test:e2e` e capturas
  de tela com playwright-core e o Chrome local.
- Mudou o prompt ou as ferramentas da Aifos: `npm run agent:eval` e republicar as Edge Functions.
- Deploys em produção (`db push`, `functions deploy`, `deploy:vps`) só com autorização explícita.
- Vários arquivos usam CRLF: scripts de substituição precisam normalizar `\r\n`.
