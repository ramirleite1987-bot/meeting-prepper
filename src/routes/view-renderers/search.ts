import type { SearchResponse, SearchResult } from '../../services/search.service.js';
import { escapeHtml } from './html.js';

type SearchClientItem = SearchResult;
type SearchMeetingItem = SearchResult & { status: string; clientName: string };
type SearchActionItem = SearchResult & {
  owner: string;
  priority: string;
  status: string;
  clientName: string;
  meetingTitle: string;
  priorityClass: string;
};

interface SearchViewData extends Record<string, unknown> {
  query: string;
  total: number;
  counts: SearchResponse['counts'];
  clients: SearchClientItem[];
  meetings: SearchMeetingItem[];
  actionItems: SearchActionItem[];
  summaryHtml: string;
  resultsHtml: string;
}

export function buildSearchViewData(data: SearchResponse): SearchViewData {
  const grouped = {
    query: data.query,
    total: data.total,
    counts: data.counts,
    clients: data.results
      .filter((result) => result.type === 'client')
      .map((result) => ({ ...result, snippet: result.snippet })),
    meetings: data.results
      .filter((result) => result.type === 'meeting')
      .map((result) => ({
        ...result,
        status: (result.meta as { status?: string }).status ?? '',
        clientName: (result.meta as { clientName?: string | null }).clientName ?? 'Unknown client',
      })),
    actionItems: data.results
      .filter((result) => result.type === 'action_item')
      .map((result) => {
        const meta = result.meta as {
          owner?: string | null;
          priority?: string;
          status?: string;
          clientName?: string | null;
          meetingTitle?: string | null;
        };
        return {
          ...result,
          owner: meta.owner ?? 'Unassigned',
          priority: meta.priority ?? 'medium',
          status: meta.status ?? 'pending',
          clientName: meta.clientName ?? 'Unknown client',
          meetingTitle: meta.meetingTitle ?? '',
          priorityClass: priorityClass(meta.priority),
        };
      }),
  };

  return {
    ...grouped,
    summaryHtml: renderSearchSummary(grouped),
    resultsHtml: renderSearchResults(grouped),
  };
}

function priorityClass(priority: string | undefined): string {
  if (priority === 'high') return 'bg-red-100 text-red-800';
  if (priority === 'low') return 'bg-green-100 text-green-800';
  return 'bg-yellow-100 text-yellow-800';
}

function renderSearchSummary(data: {
  query: string;
  total: number;
  counts: SearchResponse['counts'];
}): string {
  if (!data.query) return '';
  return `<div class="text-sm text-gray-600">
    <span class="font-semibold text-gray-900">${data.total}</span> result(s) for
    <span class="font-mono bg-gray-100 px-2 py-0.5 rounded">${escapeHtml(data.query)}</span>
    &nbsp;&middot;&nbsp; ${data.counts.clients} clients &middot; ${data.counts.meetings} meetings &middot; ${data.counts.action_items} action items
  </div>`;
}

function renderSearchSection<T>(
  title: string,
  items: T[],
  renderItem: (item: T) => string,
): string {
  if (items.length === 0) return '';
  return `<section>
    <h2 class="text-lg font-semibold text-gray-900 mb-3">${escapeHtml(title)}</h2>
    <ul class="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
      ${items.map(renderItem).join('')}
    </ul>
  </section>`;
}

function renderSearchResults(data: {
  query: string;
  total: number;
  clients: SearchClientItem[];
  meetings: SearchMeetingItem[];
  actionItems: SearchActionItem[];
}): string {
  if (!data.query) {
    return `<div class="bg-white border border-gray-200 rounded-lg p-8 text-center text-gray-500">
      Type a query above to search across your meeting prep workspace.
    </div>`;
  }
  if (data.total === 0) {
    return `<div class="bg-white border border-gray-200 rounded-lg p-8 text-center text-gray-500">
      No matches for <span class="font-mono">${escapeHtml(data.query)}</span>.
    </div>`;
  }

  return [
    renderSearchSection(
      'Clients',
      data.clients,
      (item) => `<li class="p-4 hover:bg-gray-50">
      <a href="${escapeHtml(item.href)}" class="block">
        <div class="font-medium text-indigo-600">${escapeHtml(item.title)}</div>
        <div class="text-sm text-gray-500 mt-0.5">${escapeHtml(item.snippet)}</div>
      </a>
    </li>`,
    ),
    renderSearchSection(
      'Meetings',
      data.meetings,
      (item) => `<li class="p-4 hover:bg-gray-50">
      <a href="${escapeHtml(item.href)}" class="block">
        <div class="flex items-center gap-2">
          <span class="font-medium text-indigo-600">${escapeHtml(item.title)}</span>
          <span class="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-600">${escapeHtml(item.status)}</span>
        </div>
        <div class="text-sm text-gray-500 mt-0.5">${escapeHtml(item.clientName)} &mdash; ${escapeHtml(item.snippet)}</div>
      </a>
    </li>`,
    ),
    renderSearchSection(
      'Action items',
      data.actionItems,
      (item) => `<li class="p-4 hover:bg-gray-50">
      <a href="${escapeHtml(item.href)}" class="block">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="font-medium text-indigo-600">${escapeHtml(item.title)}</span>
          <span class="text-xs px-2 py-0.5 rounded ${item.priorityClass}">${escapeHtml(item.priority)}</span>
          <span class="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-600">${escapeHtml(item.status)}</span>
        </div>
        <div class="text-sm text-gray-500 mt-0.5">${escapeHtml(item.clientName)} &middot; ${escapeHtml(item.meetingTitle)} &middot; owner: ${escapeHtml(item.owner)}</div>
        <div class="text-sm text-gray-600 mt-1">${escapeHtml(item.snippet)}</div>
      </a>
    </li>`,
    ),
  ].join('');
}
