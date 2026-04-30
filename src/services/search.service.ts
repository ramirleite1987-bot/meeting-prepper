import { getDb } from '../db/index.js';

export interface SearchResult {
  type: 'client' | 'meeting' | 'action_item';
  id: string;
  title: string;
  snippet: string;
  href: string;
  meta: Record<string, unknown>;
}

export interface SearchResponse {
  query: string;
  total: number;
  counts: { clients: number; meetings: number; action_items: number };
  results: SearchResult[];
}

const MAX_PER_TYPE = 25;
const SNIPPET_RADIUS = 60;

function buildSnippet(text: string | null | undefined, term: string): string {
  if (!text) return '';
  const lower = text.toLowerCase();
  const idx = lower.indexOf(term.toLowerCase());
  if (idx < 0) {
    return text.length > SNIPPET_RADIUS * 2 ? text.slice(0, SNIPPET_RADIUS * 2) + '…' : text;
  }
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(text.length, idx + term.length + SNIPPET_RADIUS);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return prefix + text.slice(start, end) + suffix;
}

export function search(query: string): SearchResponse {
  const trimmed = query.trim();
  if (!trimmed) {
    return {
      query: '',
      total: 0,
      counts: { clients: 0, meetings: 0, action_items: 0 },
      results: [],
    };
  }

  const db = getDb();
  const like = `%${trimmed.replace(/[\\%_]/g, (m) => '\\' + m)}%`;

  const clientRows = db
    .prepare(
      `SELECT id, name, project, updated_at
       FROM clients
       WHERE name LIKE ? ESCAPE '\\' OR project LIKE ? ESCAPE '\\'
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(like, like, MAX_PER_TYPE) as Array<{
    id: string;
    name: string;
    project: string | null;
    updated_at: string;
  }>;

  const meetingRows = db
    .prepare(
      `SELECT m.id, m.title, m.status, m.scheduled_at, m.briefing, m.client_id, c.name AS client_name
       FROM meetings m
       LEFT JOIN clients c ON c.id = m.client_id
       WHERE m.title LIKE ? ESCAPE '\\' OR m.briefing LIKE ? ESCAPE '\\' OR m.post_call_notes LIKE ? ESCAPE '\\'
       ORDER BY m.scheduled_at DESC
       LIMIT ?`,
    )
    .all(like, like, like, MAX_PER_TYPE) as Array<{
    id: string;
    title: string;
    status: string;
    scheduled_at: string | null;
    briefing: string | null;
    client_id: string;
    client_name: string | null;
  }>;

  const actionItemRows = db
    .prepare(
      `SELECT a.id, a.title, a.description, a.owner, a.priority, a.status, a.deadline,
              a.meeting_id, m.title AS meeting_title, m.client_id, c.name AS client_name
       FROM action_items a
       LEFT JOIN meetings m ON m.id = a.meeting_id
       LEFT JOIN clients c ON c.id = m.client_id
       WHERE a.title LIKE ? ESCAPE '\\'
          OR a.description LIKE ? ESCAPE '\\'
          OR a.owner LIKE ? ESCAPE '\\'
       ORDER BY a.created_at DESC
       LIMIT ?`,
    )
    .all(like, like, like, MAX_PER_TYPE) as Array<{
    id: string;
    title: string;
    description: string | null;
    owner: string | null;
    priority: string;
    status: string;
    deadline: string | null;
    meeting_id: string;
    meeting_title: string | null;
    client_id: string | null;
    client_name: string | null;
  }>;

  const results: SearchResult[] = [];

  for (const c of clientRows) {
    results.push({
      type: 'client',
      id: c.id,
      title: c.name,
      snippet: c.project ? `Project: ${c.project}` : 'No project set',
      href: `/clients/${c.id}`,
      meta: { project: c.project, updated_at: c.updated_at },
    });
  }

  for (const m of meetingRows) {
    const briefingHit = m.briefing && m.briefing.toLowerCase().includes(trimmed.toLowerCase());
    const snippet = briefingHit
      ? buildSnippet(m.briefing, trimmed)
      : `${m.client_name ?? 'Unknown client'} • ${m.status}`;
    results.push({
      type: 'meeting',
      id: m.id,
      title: m.title,
      snippet,
      href: `/briefing/${m.id}`,
      meta: {
        clientId: m.client_id,
        clientName: m.client_name,
        status: m.status,
        scheduledAt: m.scheduled_at,
      },
    });
  }

  for (const a of actionItemRows) {
    const descHit = a.description && a.description.toLowerCase().includes(trimmed.toLowerCase());
    const snippet = descHit
      ? buildSnippet(a.description, trimmed)
      : `${a.owner ?? 'Unassigned'} • ${a.priority} • ${a.status}`;
    results.push({
      type: 'action_item',
      id: a.id,
      title: a.title,
      snippet,
      href: `/post-call/${a.meeting_id}`,
      meta: {
        owner: a.owner,
        priority: a.priority,
        status: a.status,
        deadline: a.deadline,
        meetingId: a.meeting_id,
        meetingTitle: a.meeting_title,
        clientName: a.client_name,
      },
    });
  }

  return {
    query: trimmed,
    total: results.length,
    counts: {
      clients: clientRows.length,
      meetings: meetingRows.length,
      action_items: actionItemRows.length,
    },
    results,
  };
}
