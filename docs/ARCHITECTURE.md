# Arquitetura

Documento detalhado de arquitetura para humanos e agentes que precisam de mais profundidade do que o `README.md` ou `CLAUDE.md`.

## Decisões de design (e por quê)

| Decisão | Por quê | Trade-off aceito |
|---|---|---|
| **Single-process, single-user** | Caso de uso é uma pessoa preparando reuniões. Sem precisar de scale-out. | Não escala horizontalmente. Não tem multi-tenant. |
| **SQLite WAL** | Zero ops, embedável, transações fortes, ótimo para single-writer. | Não dá para rodar múltiplas instâncias contra o mesmo `.db`. |
| **Sem fila externa** | Webhook handler usa `setImmediate` para off-loading. Suficiente para o volume esperado. | Trabalho assíncrono morre se o processo cair antes de terminar. |
| **HTML SSR + Tailwind CDN** | Sem build de frontend, deploy mais simples, latência menor. | Sem reatividade rica. Sem TypeScript no client. |
| **Adapter pattern** | Permite ligar/desligar fontes de contexto via env. | Ligeira complexidade extra na agregação. |
| **Idempotência via `context_hash`** | Webhooks Linear e retries de extraction devem poder repetir sem corromper estado. | Precisa garantir que o hash captura todos campos relevantes. |
| **Zod em todos os boundaries** | Falha rápida e mensagens claras quando um payload externo está fora do contrato. | Custo de runtime pequeno. |

## Camadas

```
┌──────────────┐
│   Routes     │  Express thin layer. Validação de query/params,
│              │  serialização de resposta. Não conhece DB nem adapters.
└──────┬───────┘
       │
┌──────▼───────┐
│   Services   │  Lógica de negócio. Orquestram adapters e DB.
│              │  Lançam AppError com statusCode quando precisam.
└──────┬───────┘
       │
   ┌───┴───┐
   ▼       ▼
┌─────┐ ┌──────────┐
│ DB  │ │ Adapters │  better-sqlite3 prepared queries; integrações
│     │ │          │  externas atrás de IDataSourceAdapter / ITaskAdapter.
└─────┘ └──────────┘
```

## Modelo de dados

```
clients ──┐
          │ 1:N
          ▼
       meetings ──┬──── meeting_sources (1:N, cache de cada fonte)
                  │
                  ├──── action_items (1:N, deduplicados por context_hash)
                  │           │
                  │           │ 1:1 (opcional)
                  │           ▼
                  │       linear_sync (UNIQUE(meeting_id, linear_issue_id))
                  │
                  └──── client_history (1:N, append-only)
```

Detalhes em `src/db/schema.sql`. Convenções:

- IDs são strings (UUIDs gerados por `utils/id-generator.ts`).
- Timestamps em SQLite são `DATETIME DEFAULT CURRENT_TIMESTAMP`.
- Campos JSON (`briefing`, `post_call_notes`, `event_data`, `decisions`, `risks`, `raw_data`) são `TEXT`. Use `JSON.parse`/`JSON.stringify` no service layer.
- FK constraints estão **on** (`PRAGMA foreign_keys = ON`).

### `context_hash` (idempotência)

```
context_hash = SHA-256(`${title}\n${description}\n${owner}\n${meeting_id}`)
```

Calculado em `reconciliation.service.ts`. Usado para deduplicar action items extraídos de múltiplas fontes (Krisp + Granola podem mencionar a mesma tarefa).

## Fluxo: gerar briefing

```
POST /api/meetings/:id/briefing
        │
        ▼
ClientContextService.aggregate(clientId, since)
        │  Promise.allSettled em todos adapters disponíveis
        │
        ├── ObsidianAdapter.fetchContext()       → ContextEntry[]
        ├── CalendarAdapter.fetchContext()       → ContextEntry[]
        ├── KrispAdapter.fetchContext()          → ContextEntry[] (MCP call)
        ├── GranolaAdapter.fetchContext()        → ContextEntry[] (MCP call)
        └── LinearAdapter.fetchOpenTasks()       → ContextEntry[]
        │
        ▼
BriefingService.generateBriefing(meetingId, clientName, contexts)
        │  Heurísticas determinísticas (sem LLM por enquanto):
        │  - Filtra/ordena por timestamp
        │  - Distribui em 5 seções:
        │      lastDeliveries, openItemsAndRisks, recentAgreements,
        │      suggestedNextSteps, recommendedQuestions
        │
        ▼
Persiste em meetings.briefing (JSON), retorna ao client.
```

Adapter falha? `Promise.allSettled` permite seguir com o que sobrou. Erros vão para `errors[]` no response.

## Fluxo: extração pós-call

```
POST /api/meetings/:id/extract
        │
        ▼
ExtractionService.extract(meetingId)
        │
        ├── KrispAdapter.fetchTranscript() → MeetingNotes
        ├── GranolaAdapter.fetchNotes()    → MeetingNotes
        │
        ▼
ReconciliationService.deduplicate(actionItems)
        │  Calcula context_hash, filtra duplicatas (DB lookup),
        │  mergeia metadata.
        │
        ▼
Persiste em action_items, retorna lista consolidada.
```

## Fluxo: sync com Linear

### Outbound (action item → Linear issue)

```
POST /api/meetings/:id/sync
        │
        ▼
SyncService.syncToLinear(meetingId)
        │
        ▼
For each pending action_item:
        │
        ├── Já existe linear_sync? → skip (idempotent)
        │
        ├── LinearAdapter.createTask(actionItem)
        │       │  withRetry com backoff exponencial
        │       ▼
        │   Linear API → issue criada
        │
        └── INSERT INTO linear_sync (UNIQUE constraint protege)
            UPDATE action_items SET status='synced'
```

### Inbound (Linear webhook → estado local)

```
POST /webhooks/linear  [HMAC-SHA256-verificado]
        │
        ▼
res.sendStatus(200)            ◀── responde imediato
        │
        ▼
setImmediate(() => {            ◀── processa async
        │
        ▼
SyncService.handleLinearUpdate({linearIssueId, status, updatedAt})
        │
        ├── Lookup em linear_sync por linear_issue_id
        │     │
        │     ├── não encontrado? → log + ignore (idempotent)
        │     └── encontrado: UPDATE action_items.status (SET, não toggle)
        │
        └── notificationService.notify(...)  [best-effort]
})
```

## Middlewares (ordem em `src/index.ts`)

1. `express.json()` / `express.urlencoded()` — parsing.
2. `traceId` — gera um `req.traceId` para correlacionar logs.
3. Request logger — loga método/path/status/duration ao final.
4. CORS (apenas em dev).
5. Static files (`public/`).
6. `/health`.
7. `/webhooks` (com `webhookVerify` HMAC interno).
8. `/api`.
9. `/` (views).
10. `errorHandler` — **deve** ser o último.

## Token management (MCP)

`utils/token-manager.ts` mantém tokens OAuth/Bearer para serviços MCP. Atributos:

- TTL com **buffer de 5 minutos** antes do `expires_at` real.
- Refresh automático se expirado/quase-expirado.
- Falha de refresh → exception propagada para o adapter, que decide.

## Logging

`utils/logger.ts`:

- Nível controlado por `LOG_LEVEL` (debug/info/warn/error).
- `logger.child('Component')` cria logger com prefix.
- Sempre estruturado: `logger.info('msg', { ...context })`.
- Não loga dados sensíveis. **Nunca** logue `LINEAR_API_KEY`, `LINEAR_WEBHOOK_SECRET`, ou `Authorization` headers.

## Testes — estratégia

| Tipo | Localização | Características |
|---|---|---|
| Unit | `tests/unit/` | Sem rede, sem disco. Mocks de adapter. Cobre services e edge cases. |
| Integration | `tests/integration/` | `supertest(app)` + SQLite `:memory:`. Cobre rotas e webhooks. |
| E2E | `tests/e2e/full-flow.test.ts` | Fluxo completo briefing → meeting → extraction → sync. |

Edge cases já cobertos (`tests/unit/edge-cases.test.ts`):

- Adapter failures não derrubam a app.
- Partial extraction quando só uma fonte responde.
- Webhooks duplicados são idempotentes.
- Reuniões vazias retornam seções vazias com perguntas default.
- Tokens stale são refreshed.
- WAL mode ativo.
- Constraints UNIQUE e FK enforced.

## Onde *não* mexer sem discutir

- Decisão "sem build de frontend" — Tailwind CDN é proposital.
- "SQLite WAL single-process" — não introduza Postgres ou pool de conexões.
- Estrutura de adapter — não acople adapter direto a route.
- Mapeamento Linear status ↔ TaskStatus existe em **dois** lugares (`linear.adapter.ts` e `routes/webhooks.ts`). Existe issue aberta para consolidar — até lá, mantenha sincronizado.

## Roadmap conhecido (issues abertas)

Veja `gh issue list` ou abra o GitHub. Áreas com débito conhecido:

- Migration tooling para o schema SQLite.
- Consolidação do mapeamento Linear status (DRY).
- LLM-assisted briefing (atualmente heurístico).
- Multi-user / multi-tenant (out of scope no momento).
- Frontend reativo (out of scope no momento).
