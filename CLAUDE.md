# CLAUDE.md

Guia para agentes de IA (Claude Code, agentes via Claude Agent SDK, droids da Factory) trabalhando neste repositório. Leia antes de fazer qualquer alteração.

## O que é este projeto

**Meeting-Prepper** (a.k.a. *Client Briefing Generator*) é um servidor Node.js + TypeScript single-process que:

1. **Antes** de uma reunião com cliente: agrega contexto (notas Obsidian, eventos de calendário ICS, históricos do Krisp/Granola, tarefas Linear) e gera um *briefing* estruturado.
2. **Durante/depois**: extrai action items das transcrições do Krisp e notas do Granola via MCP.
3. **Sync bidirecional com Linear**: cria issues a partir de action items, recebe webhooks HMAC-assinados quando o status muda no Linear, atualiza o estado local de forma idempotente.
4. Expõe um **dashboard web SSR** (HTML + Tailwind via CDN, sem build de frontend) e uma API REST JSON.

Single-user, single-process. SQLite WAL (não Postgres). Sem fila externa — `setImmediate` para off-loading de webhooks.

## Comandos essenciais

| Comando | Quando usar |
|---|---|
| `npm run dev` | Desenvolvimento local com hot-reload (`tsx watch`). |
| `npm run build` | Compila TS → `dist/`. |
| `npm start` | Roda o build de produção. |
| `npm test` | Roda **toda** a suíte vitest (unit + integration + e2e). Default para verificação. |
| `npm run test:watch` | Vitest em watch durante desenvolvimento. |
| `npm run test:coverage` | Coverage via `@vitest/coverage-v8`. |
| `npm run typecheck` | `tsc --noEmit` — rode antes de commitar mudanças não-triviais. |
| `npm run lint` / `lint:fix` | ESLint sobre `src/`. Regras estritas: `eqeqeq`, `no-throw-literal`, `consistent-type-imports`, `no-console` (warn). |
| `npm run format` / `format:check` | Prettier. |

`husky` + `lint-staged` rodam `eslint --fix` + `prettier` em arquivos staged automaticamente.

## Arquitetura (alto nível)

```
src/
├── index.ts            # Bootstrap Express, middlewares, shutdown gracioso
├── config.ts           # Carrega .env via dotenv → valida com Zod (fail-fast)
├── db/                 # better-sqlite3 (WAL), schema.sql, prepared queries
├── middleware/         # trace-id, error-handler, async-handler, webhook-verify
├── adapters/           # Integrações externas — TODAS implementam IDataSourceAdapter ou ITaskAdapter
│   ├── obsidian.adapter.ts   # Lê markdown do vault local
│   ├── calendar.adapter.ts   # Faz fetch de feed ICS
│   ├── krisp.adapter.ts      # MCP client → transcrições
│   ├── granola.adapter.ts    # MCP client → notas estruturadas
│   └── linear.adapter.ts     # @linear/sdk, sync de tarefas
├── services/           # Lógica de domínio. NUNCA chame adapters direto das routes.
│   ├── client-context.service.ts    # Agrega ContextEntry[] de todos adapters disponíveis
│   ├── briefing.service.ts          # Gera briefing estruturado (5 seções)
│   ├── briefing-export.service.ts   # Markdown export
│   ├── extraction.service.ts        # Extrai action items pós-call (Promise.allSettled)
│   ├── reconciliation.service.ts    # Dedup por context_hash (SHA-256)
│   ├── sync.service.ts              # Linear bidirecional + idempotência
│   ├── action-items.service.ts      # CRUD + listagem agregada
│   ├── agenda.service.ts            # Buckets: overdue/today/tomorrow/this_week/later
│   ├── search.service.ts            # FTS-like sobre meetings/clients/action_items
│   ├── stats.service.ts             # KPIs do dashboard
│   └── notification.service.ts      # Webhook outbound best-effort
├── routes/             # Express routers — finos, delegam para services
│   ├── api.ts          # /api/* JSON
│   ├── views.ts        # / SSR HTML
│   └── webhooks.ts     # /webhooks/linear (HMAC-verificado)
├── utils/              # logger (filho com prefix), mcp-client, token-manager, id-generator
└── views/              # Templates HTML estáticos (string concat / interpolation)
```

### Princípios arquiteturais (não viole)

1. **Routes → Services → (DB | Adapters).** Routes não acessam DB nem adapters direto. Services não importam Express.
2. **Adapters são opcionais e *gracefully degradable*.** Se `OBSIDIAN_VAULT_PATH` não estiver setado, o `ObsidianAdapter` se reporta como não-disponível via `isAvailable()` e o briefing é gerado com o que sobrar. Use `Promise.allSettled` ao agregar fontes — falha em um adapter **nunca** derruba a request.
3. **Idempotência é obrigatória** em qualquer operação disparada por webhook ou retry de sync:
   - Action items são deduplicados via `context_hash` (SHA-256 sobre title+description+owner+meeting_id).
   - `linear_sync` tem `UNIQUE(meeting_id, linear_issue_id)`.
   - Webhooks Linear: status updates são SET (não toggle); IDs desconhecidos são logados e ignorados.
4. **Erros de servidor não vazam internals.** O `errorHandler` esconde mensagens de 5xx em produção; só 4xx têm mensagens repassadas.
5. **Trace ID em todo log.** O middleware `traceId` injeta `req.traceId`; passe-o adiante quando fizer chamadas async.

## Convenções de código (críticas)

- **Module system: NodeNext.** *Sempre* importe arquivos locais com extensão `.js` (mesmo em `.ts`):
  ```ts
  import { foo } from './bar.js';   // ✅
  import { foo } from './bar';      // ❌ quebra em runtime
  ```
- **`import type` para tipos puros** (regra `consistent-type-imports`).
- **Sem `console.*`** — use `logger.child('Component')` e métodos `info/warn/error/debug`.
- **`eqeqeq`** sempre — `===` / `!==`.
- **Validação com Zod** em qualquer boundary externo (env, request body de POST, payload de webhook).
- **Comentários: WHY, não WHAT.** O código já diz o que faz.

## Banco de dados

- **better-sqlite3 em modo WAL**, ativado em `db/index.ts` via PRAGMA. Síncrono, single-writer.
- `db/schema.sql` é a fonte da verdade. Migrações ainda não existem — ao alterar schema, atualize esse arquivo e considere abrir issue para migration tooling.
- Use `queries.*` (prepared statements em `db/index.ts`); evite SQL inline em routes/services.
- FK constraints **estão habilitadas** (`PRAGMA foreign_keys = ON`).

## MCP & integrações

- `utils/mcp-client.ts` cria conexão `StreamableHTTPClientTransport` autenticada via `tokenManager` (refresh com buffer de 5 min).
- Krisp/Granola adapters são opcionais — só ativos se a respectiva env `*_MCP_SERVER_URL` estiver setada.
- Linear webhooks são verificados via HMAC-SHA256 com `LINEAR_WEBHOOK_SECRET` no middleware `webhookVerify`. Sem o secret, webhooks são rejeitados.

## Testes

- **Unit** (`tests/unit/`): services e edge cases. Sem rede, sem disco real. Use mocks de adapter.
- **Integration** (`tests/integration/`): supertest contra `app` exportado em `src/index.ts`, SQLite em `:memory:` (`DATABASE_PATH=:memory:`).
- **E2E** (`tests/e2e/full-flow.test.ts`): fluxo completo briefing → meeting → extraction → sync.
- Antes de marcar uma tarefa como completa: rode `npm test` *e* `npm run typecheck`. Se algum quebrar, **não** marque como completa.

## Configuração (env)

Veja `.env.example` para a lista canônica. Em runtime, `config.ts` valida tudo com Zod e dá fail-fast com mensagens formatadas. Adicione novas envs **lá** — não leia `process.env` em outros lugares (exceção: adapters que dependem de chaves SDK específicas, como `LINEAR_API_KEY`).

## Antes de submeter mudanças

1. `npm run typecheck && npm run lint && npm test` — todos verdes.
2. Se mexeu em adapter/service, adicione/atualize teste unit.
3. Se mexeu em route, adicione/atualize teste de integration.
4. Se mexeu em schema SQL, atualize `schema.sql` e documente o impacto na PR.
5. Commits seguem o estilo conciso já presente no `git log`. Mensagem em **inglês**, foco no *why*.
6. Branch de desenvolvimento atual (este agente): `claude/improve-ai-docs-hxJKa` (não pushe direto em `main`).

## Riscos conhecidos / armadilhas

- Esquecer `.js` no import → erro só em runtime, não pego pelo `tsc`.
- Chamar `logger.info(string, error)` com objeto `Error` cru — sempre embrulhe em `{ error: err.message }` para serializar.
- `setImmediate` no webhook handler dispara processamento assíncrono *após* o 200 — exceções não-tratadas viram unhandled rejection. Use `.catch()` em toda chain.
- SQLite WAL gera arquivos `-wal` e `-shm` ao lado do `.db`. Não commite.
- Tailwind via CDN — não tente adicionar build do frontend "para otimizar" sem discutir antes (decisão arquitetural explícita).
