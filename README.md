# Meeting-Prepper

> Client Briefing Generator — meeting prep e ponte de execução pós-call.

Servidor Node.js single-process que agrega contexto de clientes de fontes diversas (Obsidian, calendário, Krisp, Granola, Linear), gera *briefings* estruturados antes de reuniões, extrai action items das transcrições pós-call e mantém sincronia bidirecional com Linear.

Single-user. SQLite WAL. Sem fila externa. Server-rendered HTML — sem build de frontend.

## Stack

- **Runtime**: Node.js 20+ LTS
- **Linguagem**: TypeScript 5 (strict, NodeNext modules)
- **HTTP**: Express 4
- **DB**: better-sqlite3 (modo WAL, single-writer)
- **Validação**: Zod
- **Integrações**: `@modelcontextprotocol/sdk` (Krisp/Granola), `@linear/sdk`
- **Frontend**: HTML server-rendered + Tailwind via CDN
- **Testes**: Vitest + supertest
- **Lint/format**: ESLint + Prettier + Husky + lint-staged

## Início rápido

```bash
# 1. Pré-requisitos
node --version    # >= 20

# 2. Instalar e configurar
npm install
cp .env.example .env
# Edite .env conforme necessário (todos os campos são opcionais por padrão).

# 3. Rodar em dev
npm run dev
# Servidor em http://localhost:3000

# 4. Verificar saúde
curl http://localhost:3000/health
```

## Comandos

| Comando | Descrição |
|---|---|
| `npm run dev` | Hot-reload via `tsx watch`. |
| `npm run build` | Compila TypeScript para `dist/`. |
| `npm start` | Roda o build (`node dist/index.js`). |
| `npm test` | Roda toda a suíte (unit + integration + e2e). |
| `npm run test:watch` | Vitest em modo watch. |
| `npm run test:coverage` | Coverage com `@vitest/coverage-v8`. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run lint` / `lint:fix` | ESLint sobre `src/`. |
| `npm run format` / `format:check` | Prettier. |

## Configuração

Todas as variáveis estão documentadas em [`.env.example`](./.env.example). Os adapters são *opcionais* — se uma env não for setada, aquele adapter simplesmente fica indisponível e a aplicação continua funcionando com o que sobrar.

Resumo das envs por categoria:

- **Servidor**: `PORT`, `NODE_ENV`, `LOG_LEVEL`
- **Database**: `DATABASE_PATH` (use `:memory:` em testes)
- **Adapters opcionais**: `OBSIDIAN_VAULT_PATH`, `CALENDAR_ICS_URL`, `KRISP_MCP_SERVER_URL`, `GRANOLA_MCP_SERVER_URL`
- **Linear** (necessário se quiser sync): `LINEAR_API_KEY`, `LINEAR_TEAM_ID`, `LINEAR_WEBHOOK_SECRET`
- **Notificações outbound**: `NOTIFICATION_WEBHOOK_URL`

## Arquitetura (visão geral)

```
┌────────────────────────────────────────────────────────────────────┐
│                        meeting-prepper (Node)                      │
│                                                                    │
│  Web UI (SSR HTML)        ┌─────────────┐                          │
│         │                 │  Routes     │                          │
│         ▼                 │  api.ts     │                          │
│  ┌──────────────┐         │  views.ts   │ ◀── HTTP                 │
│  │   Express    │◀────────┤  webhooks   │                          │
│  └──────┬───────┘         └──────┬──────┘                          │
│         │                        │                                 │
│         ▼                        ▼                                 │
│  ┌──────────────────────────────────────────┐                      │
│  │              Services (lógica)           │                      │
│  │  briefing • extraction • sync •          │                      │
│  │  reconciliation • agenda • search • ...  │                      │
│  └─┬───────────────────────────────────┬────┘                      │
│    │                                   │                           │
│    ▼                                   ▼                           │
│  ┌─────────────────┐         ┌────────────────────────────┐        │
│  │ better-sqlite3  │         │ Adapters (boundary)        │        │
│  │ (WAL mode)      │         │ obsidian • calendar (ICS)  │        │
│  └─────────────────┘         │ krisp/granola (MCP)        │        │
│                              │ linear (@linear/sdk)       │        │
│                              └────────────────────────────┘        │
└────────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
                              Obsidian | ICS | MCP | Linear API
```

Para detalhes de fluxo de dados (briefing, extraction, sync) e contratos entre camadas, veja [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Para agentes de IA

Este repositório foi documentado para uso intensivo com agentes:

- **`CLAUDE.md`** — guia detalhado para Claude Code / Agent SDK.
- **`AGENTS.md`** — guia genérico (Cursor, Aider, Copilot, droids da Factory, Codex, etc.).

Antes de pedir para um agente alterar o código, garanta que ele leu pelo menos um dos dois.

## Endpoints principais

- `GET /` — Dashboard (HTML).
- `GET /health` — Health check (status do DB).
- `GET /api/clients`, `POST /api/clients` — CRUD de clientes.
- `GET /api/meetings`, `POST /api/meetings` — CRUD de reuniões.
- `POST /api/meetings/:id/briefing` — Gera briefing.
- `POST /api/meetings/:id/extract` — Extrai action items pós-call.
- `POST /api/meetings/:id/sync` — Sincroniza action items para Linear.
- `POST /webhooks/linear` — Recebe atualizações do Linear (HMAC-verificado).

API completa em `src/routes/api.ts`.

## CI

Workflows em `.github/workflows/`:

- `ci.yml` — typecheck + lint + test em cada PR.
- `pr-checks.yml` — checks adicionais.
- `droid-review.yml` — review automático Factory Droid em PRs.
- `droid.yml` — `@droid` mention handler em issues e PR comments.

## Licença

Privado. Não publicado em registry.
