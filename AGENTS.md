# Agent Guidance

Meeting Prepper is a Node.js 20 TypeScript/Express app that generates client briefings and bridges pre-meeting context with post-call execution. Keep adapters isolated and validate all external inputs.

## Project structure

- `src/index.ts` wires Express middleware, static assets, health checks, webhooks, API routes, and view routes.
- `src/config.ts` loads environment variables through Zod.
- `src/db/` owns SQLite setup and schema.
- `src/adapters/` integrates Calendar, Git, Granola, Krisp, Linear, Obsidian, and Telegram.
- `src/services/` contains briefing, extraction, reconciliation, sync, notification, and client-context logic.
- `src/routes/` contains API, web view, and webhook routes.
- `src/views/` contains HTML templates copied during build.
- `tests/` contains unit, integration, and e2e tests.

## Commands

- Install dependencies: `npm install`
- Start dev server with watch mode: `npm run dev`
- Build: `npm run build`
- Start built app: `npm start`
- Run tests: `npm test`
- Run tests in watch mode: `npm run test:watch`
- Run lint: `npm run lint`
- Apply lint fixes: `npm run lint:fix`

## Environment and runtime data

- Requires Node.js 20+.
- Default SQLite database path is `./data/meeting-prepper.db`.
- Optional integrations are configured through environment variables for Obsidian, calendar ICS, Telegram, GitHub, Krisp MCP, Granola MCP, and Linear.
- Never commit local databases, tokens, webhook secrets, or generated runtime data.

## Implementation notes

- Use existing adapter interfaces in `src/adapters/types.ts`; do not couple services directly to external SDKs when an adapter exists.
- Keep validation at boundaries with Zod and narrow types before passing data into services.
- Preserve `.js` extensions in TypeScript imports because the project emits ESM for Node.
- When changing views, consider matching route/service changes and update integration tests where behavior shifts.
- For webhook changes, preserve signature verification in `src/middleware/webhook-verify.ts`.

## Validation

Run targeted Vitest tests for changed services or adapters, then `npm test`. Run `npm run build` after changing TypeScript, views, database schema, or build-copy behavior.
