import { getDb } from '../db/index.js';

export interface StatsResponse {
  generatedAt: string;
  clients: { total: number };
  meetings: {
    total: number;
    scheduled: number;
    inProgress: number;
    completed: number;
    withBriefing: number;
    briefingCoveragePct: number;
  };
  actionItems: {
    total: number;
    pending: number;
    synced: number;
    completed: number;
    high: number;
    medium: number;
    low: number;
    overdue: number;
  };
  linearSync: {
    total: number;
    created: number;
    updated: number;
    closed: number;
  };
  topClients: Array<{ id: string; name: string; meetings_30d: number }>;
  topOwners: Array<{ owner: string; open_items: number }>;
  averages: {
    actionItemsPerCompletedMeeting: number | null;
  };
}

function countWhere(table: string, where = '', params: unknown[] = []): number {
  const sql = where
    ? `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`
    : `SELECT COUNT(*) AS n FROM ${table}`;
  const row = getDb()
    .prepare(sql)
    .get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function buildStats(now: Date = new Date()): StatsResponse {
  const db = getDb();
  const nowIso = now.toISOString();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const totalClients = countWhere('clients');

  const totalMeetings = countWhere('meetings');
  const scheduledMeetings = countWhere('meetings', 'status = ?', ['scheduled']);
  const inProgressMeetings = countWhere('meetings', 'status = ?', ['in_progress']);
  const completedMeetings = countWhere('meetings', 'status = ?', ['completed']);
  const meetingsWithBriefing = countWhere('meetings', 'briefing IS NOT NULL');
  const briefingCoveragePct =
    totalMeetings === 0 ? 0 : Math.round((meetingsWithBriefing * 100) / totalMeetings);

  const totalActionItems = countWhere('action_items');
  const pendingActionItems = countWhere('action_items', 'status = ?', ['pending']);
  const syncedActionItems = countWhere('action_items', 'status = ?', ['synced']);
  const completedActionItems = countWhere('action_items', 'status = ?', ['completed']);
  const highActionItems = countWhere('action_items', 'priority = ?', ['high']);
  const mediumActionItems = countWhere('action_items', 'priority = ?', ['medium']);
  const lowActionItems = countWhere('action_items', 'priority = ?', ['low']);
  const overdueActionItems = countWhere(
    'action_items',
    "deadline IS NOT NULL AND deadline < ? AND status != 'completed'",
    [nowIso],
  );

  const totalLinearSync = countWhere('linear_sync');
  const createdSync = countWhere('linear_sync', 'sync_status = ?', ['created']);
  const updatedSync = countWhere('linear_sync', 'sync_status = ?', ['updated']);
  const closedSync = countWhere('linear_sync', 'sync_status = ?', ['closed']);

  const topClients = db
    .prepare(
      `SELECT c.id, c.name, COUNT(m.id) AS meetings_30d
       FROM clients c
       LEFT JOIN meetings m ON m.client_id = c.id AND m.scheduled_at >= ?
       GROUP BY c.id
       HAVING meetings_30d > 0
       ORDER BY meetings_30d DESC, c.updated_at DESC
       LIMIT 5`,
    )
    .all(thirtyDaysAgo) as Array<{ id: string; name: string; meetings_30d: number }>;

  const topOwners = db
    .prepare(
      `SELECT owner, COUNT(*) AS open_items
       FROM action_items
       WHERE owner IS NOT NULL AND owner != '' AND status != 'completed'
       GROUP BY owner
       ORDER BY open_items DESC
       LIMIT 5`,
    )
    .all() as Array<{ owner: string; open_items: number }>;

  const avgRow = db
    .prepare(
      `SELECT AVG(cnt) AS avg
       FROM (
         SELECT COUNT(a.id) AS cnt
         FROM meetings m
         LEFT JOIN action_items a ON a.meeting_id = m.id
         WHERE m.status = 'completed'
         GROUP BY m.id
       )`,
    )
    .get() as { avg: number | null } | undefined;

  return {
    generatedAt: now.toISOString(),
    clients: { total: totalClients },
    meetings: {
      total: totalMeetings,
      scheduled: scheduledMeetings,
      inProgress: inProgressMeetings,
      completed: completedMeetings,
      withBriefing: meetingsWithBriefing,
      briefingCoveragePct,
    },
    actionItems: {
      total: totalActionItems,
      pending: pendingActionItems,
      synced: syncedActionItems,
      completed: completedActionItems,
      high: highActionItems,
      medium: mediumActionItems,
      low: lowActionItems,
      overdue: overdueActionItems,
    },
    linearSync: {
      total: totalLinearSync,
      created: createdSync,
      updated: updatedSync,
      closed: closedSync,
    },
    topClients,
    topOwners,
    averages: {
      actionItemsPerCompletedMeeting:
        avgRow?.avg !== null && avgRow?.avg !== undefined
          ? Math.round((avgRow.avg as number) * 10) / 10
          : null,
    },
  };
}
