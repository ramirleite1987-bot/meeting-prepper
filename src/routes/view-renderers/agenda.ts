import type { AgendaBucket, AgendaMeeting, AgendaResponse } from '../../services/agenda.service.js';
import { escapeHtml } from './html.js';

type AgendaBaseViewMeeting = AgendaMeeting & {
  scheduled_label: string;
  starts_in_label: string;
  client_name: string;
};

type AgendaViewMeeting = AgendaBaseViewMeeting & {
  needs_briefing: boolean;
  needs_post_call: boolean;
};

type AgendaViewBucket = AgendaResponse['buckets'][number] & {
  colorClass: string;
  meetings: AgendaViewMeeting[];
};

export interface AgendaViewData extends Record<string, unknown> {
  nextHtml: string;
  bucketsHtml: string;
}

export function buildAgendaViewData(agenda: AgendaResponse): AgendaViewData {
  const next = agenda.next
    ? {
        ...agenda.next,
        starts_in_label: formatStartsIn(agenda.next.starts_in_minutes),
        scheduled_label: formatSchedule(agenda.next.scheduled_at),
        client_name: agenda.next.client_name ?? 'Unknown client',
      }
    : null;

  const buckets = agenda.buckets.map((bucket) => ({
    ...bucket,
    colorClass: bucketColor(bucket.bucket),
    meetings: bucket.meetings.map((meeting) => ({
      ...meeting,
      scheduled_label: formatSchedule(meeting.scheduled_at),
      starts_in_label: formatStartsIn(meeting.starts_in_minutes),
      client_name: meeting.client_name ?? 'Unknown client',
      needs_briefing: !meeting.has_briefing && meeting.status !== 'completed',
      needs_post_call: meeting.status === 'completed' && !meeting.has_post_call,
    })),
  }));

  return {
    nextHtml: renderAgendaNext(next),
    bucketsHtml: renderAgendaBuckets(buckets),
  };
}

function formatSchedule(scheduledAt: string | null): string {
  return scheduledAt ? new Date(scheduledAt).toLocaleString() : 'Unscheduled';
}

function formatStartsIn(minutes: number | null): string {
  if (minutes === null) return '';
  const abs = Math.abs(minutes);
  if (abs < 60) return minutes < 0 ? `${abs} min ago` : `in ${minutes} min`;
  const hours = Math.round(abs / 60);
  if (hours < 24) return minutes < 0 ? `${hours}h ago` : `in ${hours}h`;
  const days = Math.round(hours / 24);
  return minutes < 0 ? `${days}d ago` : `in ${days}d`;
}

function bucketColor(bucket: AgendaBucket): string {
  switch (bucket) {
    case 'overdue':
      return 'bg-red-50 border-red-200';
    case 'today':
      return 'bg-indigo-50 border-indigo-200';
    case 'tomorrow':
      return 'bg-blue-50 border-blue-200';
    case 'this_week':
    case 'later':
      return 'bg-white border-gray-200';
    default:
      return 'bg-gray-50 border-gray-200';
  }
}

function renderAgendaNext(meeting: AgendaBaseViewMeeting | null): string {
  if (!meeting) return '';
  const prepareForm = meeting.has_briefing
    ? ''
    : `<form method="post" action="/briefing/prepare" class="inline-block">
        <input type="hidden" name="meetingId" value="${escapeHtml(meeting.id)}" />
        <button type="submit" class="px-4 py-2 bg-white/20 border border-white/40 text-white rounded-md text-sm font-medium hover:bg-white/30">Prepare briefing</button>
      </form>`;

  return `<section class="rounded-xl bg-gradient-to-br from-indigo-600 to-purple-600 text-white p-6 shadow-md">
    <div class="text-xs uppercase tracking-wide font-semibold opacity-80">Up next</div>
    <div class="mt-1 flex flex-wrap items-baseline justify-between gap-3">
      <h2 class="text-2xl font-bold">${escapeHtml(meeting.title)}</h2>
      <span class="text-sm font-medium bg-white/20 rounded-full px-3 py-1">${escapeHtml(meeting.starts_in_label)}</span>
    </div>
    <div class="text-sm opacity-90 mt-1">${escapeHtml(meeting.client_name)} &middot; ${escapeHtml(meeting.scheduled_label)}</div>
    <div class="mt-4 flex gap-2">
      <a href="/briefing/${escapeHtml(meeting.id)}" class="inline-block px-4 py-2 bg-white text-indigo-700 rounded-md text-sm font-medium hover:bg-indigo-50">View briefing</a>
      ${prepareForm}
    </div>
  </section>`;
}

function renderAgendaMeeting(meeting: AgendaViewMeeting): string {
  const startsIn = meeting.starts_in_label
    ? ` &middot; ${escapeHtml(meeting.starts_in_label)}`
    : '';
  const briefed = meeting.has_briefing
    ? '<span class="text-xs px-2 py-0.5 rounded bg-green-100 text-green-800">briefed</span>'
    : '';
  const postCall = meeting.has_post_call
    ? '<span class="text-xs px-2 py-0.5 rounded bg-purple-100 text-purple-800">post-call</span>'
    : '';
  const prepare = meeting.needs_briefing
    ? `<form method="post" action="/briefing/prepare">
        <input type="hidden" name="meetingId" value="${escapeHtml(meeting.id)}" />
        <button type="submit" class="px-3 py-1.5 text-xs font-medium bg-indigo-600 text-white rounded-md hover:bg-indigo-700">Prepare</button>
      </form>`
    : '';
  const review = meeting.needs_post_call
    ? `<a href="/post-call/${escapeHtml(meeting.id)}" class="px-3 py-1.5 text-xs font-medium border border-gray-300 rounded-md hover:bg-gray-50">Review</a>`
    : '';
  const postCallLink = meeting.has_post_call
    ? `<a href="/post-call/${escapeHtml(meeting.id)}" class="px-3 py-1.5 text-xs font-medium border border-gray-300 rounded-md hover:bg-gray-50">Post-call</a>`
    : '';

  return `<li class="p-4 flex items-start gap-4 bg-white/60">
    <div class="flex-1 min-w-0">
      <div class="flex items-center gap-2 flex-wrap">
        <a href="/briefing/${escapeHtml(meeting.id)}" class="font-medium text-indigo-600 hover:underline">${escapeHtml(meeting.title)}</a>
        <span class="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-700">${escapeHtml(meeting.status)}</span>
        ${briefed}
        ${postCall}
      </div>
      <div class="text-sm text-gray-500 mt-0.5">${escapeHtml(meeting.client_name)} &middot; ${escapeHtml(meeting.scheduled_label)}${startsIn}</div>
    </div>
    <div class="shrink-0 flex flex-col gap-2 items-end text-right">${prepare}${review}${postCallLink}</div>
  </li>`;
}

function renderAgendaBuckets(buckets: AgendaViewBucket[]): string {
  if (buckets.length === 0) {
    return `<div class="bg-white border border-gray-200 rounded-lg p-8 text-center text-gray-500">
      No meetings yet. Add a meeting from the dashboard to see it here.
    </div>`;
  }

  return buckets
    .map((bucket) => {
      const meetingsHtml = bucket.meetings.map(renderAgendaMeeting).join('');
      return `<section>
      <h2 class="text-lg font-semibold text-gray-900 mb-3 flex items-center gap-2">
        <span>${escapeHtml(bucket.label)}</span>
        <span class="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">${bucket.count}</span>
      </h2>
      <ul class="rounded-lg border ${bucket.colorClass} divide-y divide-gray-100 overflow-hidden">${meetingsHtml}</ul>
    </section>`;
    })
    .join('');
}
