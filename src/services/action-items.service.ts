import { getDb } from '../db/index.js';

export type ActionItemStatus = 'pending' | 'synced' | 'completed';
export type ActionItemPriority = 'high' | 'medium' | 'low';

export interface ActionItemListFilters {
  status?: string;
  priority?: string;
  owner?: string;
  clientId?: string;
  q?: string;
}

export interface ActionItemListRow {
  id: string;
  title: string;
  description: string | null;
  owner: string | null;
  priority: string;
  status: string;
  deadline: string | null;
  source: string;
  meeting_id: string;
  meeting_title: string | null;
  client_id: string | null;
  client_name: string | null;
  created_at: string;
}

const VALID_STATUSES: ReadonlySet<string> = new Set(['pending', 'synced', 'completed']);
const VALID_PRIORITIES: ReadonlySet<string> = new Set(['high', 'medium', 'low']);

export function listActionItems(filters: ActionItemListFilters): ActionItemListRow[] {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];

  if (filters.status && VALID_STATUSES.has(filters.status)) {
    where.push('a.status = ?');
    params.push(filters.status);
  }
  if (filters.priority && VALID_PRIORITIES.has(filters.priority)) {
    where.push('a.priority = ?');
    params.push(filters.priority);
  }
  if (filters.owner) {
    where.push('a.owner = ?');
    params.push(filters.owner);
  }
  if (filters.clientId) {
    where.push('m.client_id = ?');
    params.push(filters.clientId);
  }
  if (filters.q && filters.q.trim()) {
    const like = `%${filters.q.trim().replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    where.push(
      "(a.title LIKE ? ESCAPE '\\' OR a.description LIKE ? ESCAPE '\\' OR a.owner LIKE ? ESCAPE '\\')",
    );
    params.push(like, like, like);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const sql = `
    SELECT a.id, a.title, a.description, a.owner, a.priority, a.status, a.deadline,
           a.source, a.meeting_id, a.created_at,
           m.title AS meeting_title, m.client_id,
           c.name AS client_name
    FROM action_items a
    LEFT JOIN meetings m ON m.id = a.meeting_id
    LEFT JOIN clients c ON c.id = m.client_id
    ${whereSql}
    ORDER BY
      CASE a.status WHEN 'pending' THEN 0 WHEN 'synced' THEN 1 ELSE 2 END,
      CASE a.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
      COALESCE(a.deadline, '9999-12-31') ASC,
      a.created_at DESC
    LIMIT 500
  `;

  return db.prepare(sql).all(...params) as ActionItemListRow[];
}

export function listOwners(): string[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT DISTINCT owner FROM action_items WHERE owner IS NOT NULL AND owner != '' ORDER BY owner ASC",
    )
    .all() as Array<{ owner: string }>;
  return rows.map((r) => r.owner);
}

export function isValidStatus(value: string): value is ActionItemStatus {
  return VALID_STATUSES.has(value);
}

export function updateStatus(id: string, status: ActionItemStatus): ActionItemListRow | null {
  const db = getDb();
  const result = db
    .prepare('UPDATE action_items SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(status, id);
  if (result.changes === 0) return null;

  return db
    .prepare(
      `SELECT a.id, a.title, a.description, a.owner, a.priority, a.status, a.deadline,
              a.source, a.meeting_id, a.created_at,
              m.title AS meeting_title, m.client_id,
              c.name AS client_name
       FROM action_items a
       LEFT JOIN meetings m ON m.id = a.meeting_id
       LEFT JOIN clients c ON c.id = m.client_id
       WHERE a.id = ?`,
    )
    .get(id) as ActionItemListRow | null;
}
