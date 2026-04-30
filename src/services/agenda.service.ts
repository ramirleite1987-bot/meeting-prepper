import { getDb } from '../db/index.js';

export type AgendaBucket = 'overdue' | 'today' | 'tomorrow' | 'this_week' | 'later' | 'unscheduled';

export interface AgendaMeeting {
  id: string;
  title: string;
  status: string;
  scheduled_at: string | null;
  client_id: string;
  client_name: string | null;
  has_briefing: boolean;
  has_post_call: boolean;
  bucket: AgendaBucket;
  starts_in_minutes: number | null;
}

export interface AgendaResponse {
  generatedAt: string;
  next: AgendaMeeting | null;
  buckets: {
    bucket: AgendaBucket;
    label: string;
    count: number;
    meetings: AgendaMeeting[];
  }[];
}

const BUCKET_LABELS: Record<AgendaBucket, string> = {
  overdue: 'Overdue',
  today: 'Today',
  tomorrow: 'Tomorrow',
  this_week: 'This week',
  later: 'Later',
  unscheduled: 'Unscheduled',
};

const BUCKET_ORDER: AgendaBucket[] = [
  'overdue',
  'today',
  'tomorrow',
  'this_week',
  'later',
  'unscheduled',
];

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function classifyBucket(scheduledAt: string | null, now: Date, status: string): AgendaBucket {
  if (!scheduledAt) return 'unscheduled';
  const dt = new Date(scheduledAt);
  if (Number.isNaN(dt.getTime())) return 'unscheduled';

  const today = startOfDay(now);
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  const dayAfterTomorrow = new Date(tomorrow.getTime() + 24 * 60 * 60 * 1000);
  const endOfWeek = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);

  if (dt.getTime() < now.getTime() && status !== 'completed') {
    if (dt.getTime() < today.getTime()) return 'overdue';
  }

  if (dt.getTime() >= today.getTime() && dt.getTime() < tomorrow.getTime()) return 'today';
  if (dt.getTime() >= tomorrow.getTime() && dt.getTime() < dayAfterTomorrow.getTime())
    return 'tomorrow';
  if (dt.getTime() >= dayAfterTomorrow.getTime() && dt.getTime() < endOfWeek.getTime())
    return 'this_week';
  if (dt.getTime() < today.getTime()) return 'overdue';
  return 'later';
}

export function buildAgenda(now: Date = new Date()): AgendaResponse {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT m.id, m.title, m.status, m.scheduled_at, m.client_id,
              m.briefing IS NOT NULL AS has_briefing,
              m.post_call_notes IS NOT NULL AS has_post_call,
              c.name AS client_name
       FROM meetings m
       LEFT JOIN clients c ON c.id = m.client_id
       ORDER BY COALESCE(m.scheduled_at, '9999-12-31') ASC`,
    )
    .all() as Array<{
    id: string;
    title: string;
    status: string;
    scheduled_at: string | null;
    client_id: string;
    has_briefing: number;
    has_post_call: number;
    client_name: string | null;
  }>;

  const meetings: AgendaMeeting[] = rows.map((r) => {
    const bucket = classifyBucket(r.scheduled_at, now, r.status);
    const startsInMinutes = r.scheduled_at
      ? Math.round((new Date(r.scheduled_at).getTime() - now.getTime()) / 60000)
      : null;
    return {
      id: r.id,
      title: r.title,
      status: r.status,
      scheduled_at: r.scheduled_at,
      client_id: r.client_id,
      client_name: r.client_name,
      has_briefing: Boolean(r.has_briefing),
      has_post_call: Boolean(r.has_post_call),
      bucket,
      starts_in_minutes: startsInMinutes,
    };
  });

  const grouped = new Map<AgendaBucket, AgendaMeeting[]>();
  for (const bucket of BUCKET_ORDER) grouped.set(bucket, []);
  for (const meeting of meetings) {
    grouped.get(meeting.bucket)!.push(meeting);
  }

  const buckets = BUCKET_ORDER.filter((b) => grouped.get(b)!.length > 0).map((bucket) => ({
    bucket,
    label: BUCKET_LABELS[bucket],
    count: grouped.get(bucket)!.length,
    meetings: grouped.get(bucket)!,
  }));

  const upcoming = meetings
    .filter(
      (m) => m.starts_in_minutes !== null && m.starts_in_minutes >= 0 && m.status !== 'completed',
    )
    .sort((a, b) => (a.starts_in_minutes ?? 0) - (b.starts_in_minutes ?? 0));

  return {
    generatedAt: now.toISOString(),
    next: upcoming[0] ?? null,
    buckets,
  };
}
