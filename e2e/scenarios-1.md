# Meeting Prepper E2E Scenarios - Batch 1

## Scope

These scenarios cover the main Meeting Prepper journeys across the HTML app, JSON API, SQLite persistence, and integration seams. Run them with an isolated `DB_PATH` and deterministic fakes for external services unless the scenario explicitly calls for a live contract check.

## Shared Test Data

- Client: `Acme Corp`, project `Project Phoenix`, aliases for `acme.com`, `buyer@acme.com`, and `pricing review`.
- Prospect: `Northstar Labs`, project `Pilot Discovery`, alias keyword `northstar pilot`.
- Meetings: one scheduled prep meeting, one completed post-call meeting, and one future meeting for agenda ordering.
- External fakes: `gog`, Krisp MCP, Granola MCP, and Linear should expose predictable responses and record the requests they receive.

## Scenarios

### 01. Dashboard Creates A Client And Meeting

Covers: `GET /`, `POST /clients`, `POST /meetings`, `GET /api/clients`, `GET /api/meetings`.

Steps:

1. Open the dashboard with an empty database.
2. Create `Acme Corp` with `Project Phoenix`.
3. Create `Q2 Roadmap Review` for that client with a scheduled date.
4. Reload the dashboard and call the clients and meetings API endpoints.

Expected:

- The dashboard redirects back to `/` after each form submission.
- The client appears in the dashboard client selector and API payload.
- The meeting appears with client name, scheduled status, and briefing action.
- No raw template markers are visible in the HTML.

### 02. API Creates Client And Prospect Records With Aliases

Covers: `POST /api/clients`, `GET /api/clients/:id`, client kind normalization, alias serialization.

Steps:

1. Create a client with `kind: "client"` and aliases.
2. Create a prospect with `kind: "prospect"` and aliases.
3. Fetch each record by ID.
4. Create another client with an unknown kind.

Expected:

- Client and prospect records persist with the expected `kind`.
- Aliases round trip as structured JSON text.
- Unknown kind falls back to the app default instead of breaking creation.
- Missing `name` returns a JSON 400 error.

### 03. Agenda Buckets Upcoming, Overdue, And Completed Meetings

Covers: `GET /agenda`, `GET /api/agenda`, `src/services/agenda.service.ts`.

Steps:

1. Seed overdue, today, tomorrow, this-week, later, unscheduled, and completed meetings.
2. Open the agenda page.
3. Fetch `/api/agenda`.

Expected:

- The API returns `next` and bucketed meetings in chronological order.
- The HTML renders each bucket with client names and timing labels.
- Meetings needing prep show briefing affordances.
- Completed meetings do not appear as needing a new briefing.

### 04. Prepare Briefing From Stored Google Context

Covers: `POST /api/meetings/:id/prepare`, `GET /briefing/:id`, `GET /api/meetings/:id/briefing`.

Steps:

1. Seed `external_context` rows for the client from Gmail and Calendar.
2. Create a scheduled meeting for the same client.
3. Generate the briefing through the API.
4. Open the briefing page and fetch the stored briefing JSON.

Expected:

- Briefing generation reads DB-backed client context sorted by recency.
- The briefing is persisted on the meeting.
- The page renders non-empty briefing sections and hides empty sections.
- The stored JSON includes the meeting ID and client name.

### 05. Export Briefing As Markdown

Covers: `GET /api/meetings/:id/briefing.md`, `src/services/briefing-export.service.ts`.

Steps:

1. Seed a meeting with a valid briefing JSON payload.
2. Request `/api/meetings/:id/briefing.md`.
3. Request `/api/meetings/:id/briefing.md?inline=1`.
4. Request the endpoint for a meeting without a briefing.

Expected:

- Markdown response contains the meeting title, client, schedule, and section content.
- Attachment mode sets a safe generated filename.
- Inline mode uses inline disposition.
- Missing briefing returns a JSON 404 error.

### 06. Google Context Sync Uses Gog And The Processes Label

Covers: `GET /api/google/status`, `POST /api/google/sync`, `public/prepare-context.js`, `GoogleContextService`.

Steps:

1. Configure the fake `gog` executor as available.
2. Seed client and prospect aliases.
3. Trigger Google sync from the dashboard prep modal or API.
4. Trigger the same sync a second time.

Expected:

- Status reports whether `gog` is available without exposing credentials.
- Gmail queries include `label:Processes`, `newer_than:<days>d`, and alias terms.
- Calendar rows and Gmail rows import into `external_context`.
- Re-running sync updates existing rows instead of duplicating them.

### 07. Krisp Source Search Uses Tags And Attaches Prep Context

Covers: `GET /api/meetings/:id/context-candidates`, `POST /api/meetings/:id/context-sources`, prep modal JS.

Steps:

1. Select a scheduled meeting in the prep modal.
2. Select source `krisp`, enter query `Acme`, and tag `handoff`.
3. Search for candidates.
4. Select one result and attach it before preparing the briefing.

Expected:

- Candidate search calls the Krisp adapter with query text plus selected tags.
- Results render with title, source, and date.
- Attach sends `source` and `externalId` for the selected note.
- The note is saved in `meeting_sources` without creating action items.

### 08. Granola Source Search Attaches Selected Meeting Notes

Covers: `GET /api/meetings/:id/context-candidates`, `POST /api/meetings/:id/context-sources`, `MeetingContextService`.

Steps:

1. Select a scheduled meeting in the prep modal.
2. Select source `granola` and search for `roadmap`.
3. Attach two Granola candidate notes.
4. Generate the meeting briefing.

Expected:

- Only Granola candidates are returned.
- Attached source rows preserve summaries, decisions, risks, and raw data.
- Briefing context includes the attached Granola summaries.
- Attaching the same external ID again updates the source row instead of duplicating it.

### 09. Pre-Meeting Context Stays Separate From Post-Call Extraction

Covers: `meeting_sources`, `action_items`, `POST /api/meetings/:id/context-sources`, `POST /api/meetings/:id/extract`.

Steps:

1. Attach Krisp or Granola notes through the prep context flow.
2. Verify the meeting has source context but no action items.
3. Run post-call extraction for the same meeting.
4. Fetch meeting action items and post-call notes.

Expected:

- Prep attachment only creates or updates `meeting_sources`.
- Extraction creates post-call notes and action items.
- Action item generation is idempotent by context hash.
- The two flows can run in either order without losing source summaries.

### 10. Post-Call Extraction Persists Summary, Decisions, Risks, And Tasks

Covers: `POST /api/meetings/:id/extract`, `GET /api/meetings/:id/post-call`, `GET /post-call/:id`.

Steps:

1. Seed a completed meeting.
2. Have Krisp and Granola fakes return notes, decisions, risks, and action items.
3. Run extraction.
4. Open the post-call review page.

Expected:

- Extraction response includes merged summary, sources, decisions, risks, and action items.
- Meeting status becomes completed when post-call notes are stored.
- Post-call page renders summary sections and extracted action items.
- Adapter failures are listed as errors without discarding successful sources.

### 11. Single Action Item Syncs To Linear With Optional Project

Covers: `POST /api/meetings/:id/action-items/:itemId/sync`, Linear adapter, notifications.

Steps:

1. Seed a meeting and a pending action item.
2. Sync the item without a project ID.
3. Sync it again with a selected Linear project ID.
4. Fetch meeting action items and recent notifications.

Expected:

- First sync creates a Linear issue and stores `linear_sync`.
- Second sync is idempotent and updates the existing issue mapping.
- Optional project ID is passed through to the sync service.
- A sync notification is recorded.

### 12. Bulk Sync Handles Partial Linear Failures

Covers: `POST /api/meetings/:id/sync-all`, `linear_sync`, action item statuses.

Steps:

1. Seed three action items for one meeting.
2. Configure Linear fake to create two issues and fail one item.
3. Run sync all.
4. Fetch all action items and sync records.

Expected:

- Response includes successful results and an errors array.
- Successful items have Linear mappings.
- Failed item remains pending and can be retried.
- The request does not fail the whole batch when one item fails.

### 13. Linear Webhook Updates Local Task Status

Covers: `POST /webhooks/linear`, signature middleware, `SyncService.handleLinearUpdate`.

Steps:

1. Seed an action item and Linear sync record.
2. Send a signed Linear `Issue` update webhook with state `Done`.
3. Wait for async webhook processing.
4. Fetch the action item and notifications.

Expected:

- Webhook returns 200 immediately.
- Local action item status maps to completed.
- Client history records the status change when the sync service updates it.
- Non-Issue webhook payloads are ignored safely.

### 14. Action Item Inbox Filters And Updates Status

Covers: `GET /action-items`, `GET /api/action-items`, `PATCH /api/action-items/:id/status`, `POST /action-items/:id/status`.

Steps:

1. Seed action items with different owners, priorities, statuses, clients, and titles.
2. Filter by owner, status, priority, client, and text query.
3. Mark a pending item completed from the HTML page.
4. Mark it pending again through the API.

Expected:

- Filters can be combined and counts update to match the filtered list.
- Distinct owner options include only non-empty owners.
- HTML status form redirects back to the requested page.
- API rejects invalid status values with a JSON 400 error.

### 15. Search Finds Clients, Meetings, And Action Items

Covers: `GET /search`, `GET /api/search`, `src/services/search.service.ts`.

Steps:

1. Seed clients, meetings with briefing text, and action items.
2. Search for `apollo`.
3. Search by an action item owner.
4. Search for SQL wildcard text such as `%`.

Expected:

- Results are grouped by clients, meetings, and action items.
- Counts match the returned result groups.
- Owner searches return matching action items.
- Wildcards are escaped and do not return every row.

### 16. Client Timeline Shows Meeting, Task, And Status Events

Covers: `GET /clients/:id`, `GET /api/clients/:id/timeline`, `client_history`.

Steps:

1. Seed a client with meeting, task-created, task-updated, and status-change events.
2. Open the client detail page.
3. Fetch the timeline API.

Expected:

- Timeline events render in reverse chronological order.
- Meeting events link to the briefing page.
- Linear issue references are displayed when present.
- Empty timelines show a clear empty state.

### 17. Stats Dashboard Summarizes Workspace Health

Covers: `GET /stats`, `GET /api/stats`, `src/services/stats.service.ts`.

Steps:

1. Seed clients, scheduled meetings, completed meetings, briefings, action items, and Linear sync rows.
2. Open the stats page.
3. Fetch the stats API.

Expected:

- API returns client, meeting, briefing, action item, and Linear sync counters.
- HTML renders top clients and owners when data exists.
- Averages handle zero completed meetings without throwing.
- Empty datasets render sensible zero states.

### 18. Notifications And SSE Stream Reflect User Workflows

Covers: `GET /api/notifications`, `GET /api/notifications/stream`, notification service.

Steps:

1. Open the SSE notification stream.
2. Generate a briefing.
3. Run post-call extraction.
4. Sync an action item to Linear.
5. Fetch recent notifications.

Expected:

- Stream receives events for briefing generation, extraction, and sync.
- Recent notifications API returns the same event types in recency order.
- Closing the SSE connection unsubscribes without errors.
- Notification failures do not fail the originating workflow.

### 19. Linear Project Import Adds Client Context

Covers: `GET /api/linear/projects`, `POST /api/clients/:id/linear-project/import`, `LinearContextService`.

Steps:

1. Configure Linear fake to return multiple projects.
2. Fetch selectable projects.
3. Import one project for `Acme Corp`.
4. Generate a briefing for a new meeting with that client.

Expected:

- Project list includes IDs, names, and update timestamps.
- Import validates `projectId` and existing client ID.
- Imported Linear issues become external context for the client.
- Later briefing generation can use the imported project context.

### 20. MCP Tools Mirror Core Read And Status Actions

Covers: `src/mcp/server.ts`, MCP read tools, `mark_action_item_status`.

Steps:

1. Seed clients, meetings, action items, and client history.
2. Call MCP tools for clients, meeting lookup, meetings by client, agenda, action items, search, and stats.
3. Call `mark_action_item_status` with a valid status.
4. Call the same tool with an invalid status and an unknown item ID.

Expected:

- MCP read tools return JSON matching the API-backed data shape.
- Status update returns the updated action item.
- Invalid status returns an MCP error result.
- Unknown item ID returns an MCP error result without changing data.
