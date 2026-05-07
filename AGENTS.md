# AGENTS.md

Instruções genéricas para agentes de IA (Cursor, Aider, Copilot, droids da Factory, Codex, Continue, etc.) que não leem `CLAUDE.md`. Para Claude Code especificamente, leia também `CLAUDE.md` (mais detalhado).

## TL;DR para o agente

- **Stack**: Node.js 20+, TypeScript 5 strict, Express 4, better-sqlite3 (WAL), Zod, Vitest.
- **Padrão de imports**: NodeNext → sempre `.js` em imports locais (mesmo dentro de `.ts`).
- **Comando único de verificação**: `npm run typecheck && npm run lint && npm test`.
- **Não rode em paralelo com a app real**: SQLite em WAL é single-writer; testes usam `:memory:`.
- **Antes de submeter PR**: rode os 3 comandos acima. PRs com lint/typecheck quebrado serão rejeitados pelo CI (`droid-review`).

## Estrutura mínima que você precisa entender

```
src/adapters/   → integrações externas (Obsidian, Calendar, Krisp/Granola via MCP, Linear)
src/services/   → lógica de negócio
src/routes/     → Express routers (api.ts, views.ts, webhooks.ts)
src/db/         → SQLite + schema.sql + prepared queries
tests/{unit,integration,e2e}/
```

Routes nunca chamam adapters direto. Services nunca importam Express.

## Regras inegociáveis

1. **Idempotência**: qualquer caminho que possa ser re-executado (webhooks, retries de sync, extraction) precisa ser idempotente. Use `context_hash` (SHA-256) e constraints UNIQUE no banco.
2. **Falha de adapter externo nunca derruba a app**. Use `Promise.allSettled` ao agregar; loga erro, segue.
3. **Nunca exponha mensagens de 5xx ao cliente**. O `errorHandler` já cuida — não remova.
4. **Nunca faça `console.log`**. Use `logger.child('Nome')`.
5. **Nunca leia `process.env` fora de `config.ts`** (exceção: adapters que recebem credenciais SDK e devem fail-fast no `initialize()`).
6. **Webhook Linear é HMAC-SHA256-verificado**. Não pule a verificação nem mude o middleware sem revisar `LINEAR_WEBHOOK_SECRET`.

## Como adicionar uma nova fonte de contexto (adapter)

1. Criar `src/adapters/<nome>.adapter.ts` implementando `IDataSourceAdapter` (de `types.ts`).
2. Métodos obrigatórios: `initialize()`, `isAvailable()`, `disconnect()`, `fetchContext(clientId, since)`.
3. Adicionar env var em `.env.example` e em `src/config.ts` (com Zod, `optional()` se opcional).
4. Registrar no `ClientContextService` (`src/services/client-context.service.ts`).
5. Adicionar teste em `tests/unit/adapters/`.

## Como adicionar uma nova rota

1. Edite `src/routes/api.ts` (JSON) ou `views.ts` (SSR).
2. Use `asyncHandler(...)` para qualquer handler async — ele propaga erro para o `errorHandler`.
3. Para novos endpoints autenticados ou com side effects sensíveis, adicione middleware específico — não inline a verificação.
4. Adicione teste de integration em `tests/integration/api.test.ts` usando `supertest(app)`.

## Como mudar o schema do DB

1. Edite `src/db/schema.sql`.
2. Atualize as `queries` em `src/db/index.ts`.
3. Não existe ferramenta de migration ainda — descreva o impacto na descrição do PR. Se a mudança não for backwards-compatible, abra também uma issue propondo migration tooling antes.

## Boas práticas que esperamos

- Mantenha mudanças pequenas e atômicas. Bug fix ≠ refactor.
- Não introduza dependências sem necessidade clara. O `package.json` está enxuto de propósito.
- Não comente código óbvio. Comente só o *porquê* não-óbvio.
- Não introduza lógica de retry própria — use o helper já existente em `linear.adapter.ts` (`withRetry`) ou padronize sobre ele.
- Não toque em arquivos de `.auto-claude/` — são artefatos do planejador.

## Onde olhar primeiro para tarefas comuns

| Quero… | Comece por… |
|---|---|
| Mudar formato do briefing | `src/services/briefing.service.ts`, `src/services/briefing-export.service.ts`, `src/views/briefing.html` |
| Adicionar campo em action item | `src/db/schema.sql`, `src/adapters/types.ts` (`ActionItem`), `src/services/action-items.service.ts` |
| Mudar mapeamento Linear ↔ interno | `src/adapters/linear.adapter.ts` (`mapLinearState`, `mapPriorityToLinear`) e `src/routes/webhooks.ts` (`mapLinearStatus`) — **mantenha os dois sincronizados** |
| Adicionar bucket na agenda | `src/services/agenda.service.ts` (`AgendaBucket`, `BUCKET_LABELS`) |
| Novo evento de notification | `src/services/notification.service.ts` |

## Sinais de que você está fazendo algo errado

- Está adicionando um `try/catch` que só re-throw a mesma coisa.
- Está criando um arquivo de "utils" para uma função usada uma vez.
- Está duplicando o mapeamento de Linear status em 3 lugares (consolide).
- Está pensando em "mockar" o `Date` global em um teste — use injection via parâmetro.
- Está prestes a commitar com `--no-verify` para pular hook que está falhando.
