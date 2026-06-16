import type { ActionItem, MeetingNotes, MeetingSummary } from './types.js';

const DEFAULT_MEETING_TITLE = 'Untitled Meeting';

type MeetingSource = 'krisp' | 'granola';

interface ExternalMeetingSummary {
  id?: unknown;
  title?: unknown;
  date?: unknown;
  attendees?: unknown;
  duration_minutes?: unknown;
}

interface ExternalActionItem {
  id?: unknown;
  title?: unknown;
  description?: unknown;
  assignee?: unknown;
  due_date?: unknown;
  priority?: unknown;
  status?: unknown;
}

interface MeetingNotesInput {
  meetingId: string;
  source: MeetingSource;
  title?: unknown;
  date?: unknown;
  attendees?: unknown;
  summary?: unknown;
  keyPoints?: unknown;
  actionItems: ActionItem[];
  rawTranscript?: unknown;
  metadata?: Record<string, unknown>;
}

export function normalizeMeetingSummary(
  source: MeetingSource,
  meeting: ExternalMeetingSummary,
): MeetingSummary {
  return {
    meetingId: normalizeString(meeting.id) ?? '',
    title: normalizeString(meeting.title) ?? DEFAULT_MEETING_TITLE,
    date: normalizeDate(meeting.date),
    attendees: normalizeStringArray(meeting.attendees),
    source,
    durationMinutes: normalizeDurationMinutes(meeting.duration_minutes),
  };
}

export function normalizeMeetingNotes(input: MeetingNotesInput): MeetingNotes {
  return {
    meetingId: input.meetingId,
    title: normalizeString(input.title) ?? DEFAULT_MEETING_TITLE,
    date: normalizeDate(input.date),
    attendees: normalizeStringArray(input.attendees),
    summary: normalizeString(input.summary) ?? '',
    keyPoints: normalizeTextArray(input.keyPoints),
    actionItems: input.actionItems,
    rawTranscript: normalizeString(input.rawTranscript),
    source: input.source,
    metadata: input.metadata,
  };
}

export function normalizeActionItem(
  source: MeetingSource,
  meetingId: string,
  item: ExternalActionItem,
): ActionItem {
  return {
    id: normalizeString(item.id),
    title: normalizeString(item.title) ?? '',
    description: normalizeString(item.description),
    assignee: normalizeString(item.assignee),
    dueDate: normalizeOptionalDate(item.due_date),
    priority: normalizePriority(item.priority),
    status: normalizeStatus(item.status),
    source,
    meetingId,
  };
}

export function normalizeActionItems(
  source: MeetingSource,
  meetingId: string,
  items: unknown,
): ActionItem[] {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.map((item) => normalizeActionItem(source, meetingId, item as ExternalActionItem));
}

export function mergeKrispKeyPoints(
  keyPoints: unknown,
  decisions: unknown,
  risks: unknown,
): string[] {
  return [
    ...normalizeTextArray(keyPoints),
    ...normalizeTextArray(decisions).map((decision) => `Decision: ${decision}`),
    ...normalizeTextArray(risks).map((risk) => `Risk: ${risk}`),
  ];
}

export function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = normalizeString(value);
    if (normalized) {
      return normalized;
    }
  }

  return undefined;
}

export function normalizeTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => String(item).trim()).filter(Boolean);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    const normalized = normalizeString(item);
    return normalized ? [normalized] : [];
  });
}

function normalizeDate(value: unknown): Date {
  return normalizeOptionalDate(value) ?? new Date();
}

function normalizeOptionalDate(value: unknown): Date | undefined {
  if (!(typeof value === 'string' || typeof value === 'number' || value instanceof Date)) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function normalizeDurationMinutes(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return value;
}

function normalizePriority(priority: unknown): ActionItem['priority'] {
  const normalized = normalizeString(priority)?.toLowerCase();
  if (normalized === 'urgent' || normalized === 'critical') return 'urgent';
  if (normalized === 'high') return 'high';
  if (normalized === 'medium' || normalized === 'normal') return 'medium';
  if (normalized === 'low') return 'low';
  return 'none';
}

function normalizeStatus(status: unknown): ActionItem['status'] {
  const normalized = normalizeString(status)?.toLowerCase();
  if (normalized === 'completed' || normalized === 'done') return 'completed';
  if (normalized === 'in-progress' || normalized === 'in_progress') return 'in-progress';
  if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled';
  return 'pending';
}
