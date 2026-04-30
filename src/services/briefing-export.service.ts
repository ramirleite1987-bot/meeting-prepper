type Briefing = Record<string, unknown>;

interface MeetingSummary {
  id: string;
  title: string;
  client_name: string | null;
  scheduled_at: string | null;
  status: string;
}

const STRING_SECTIONS: Array<{ key: string; heading: string }> = [
  { key: 'executiveSummary', heading: 'Executive Summary' },
  { key: 'clientBackground', heading: 'Client Background' },
];

const LIST_SECTIONS: Array<{ key: string; heading: string }> = [
  { key: 'keyTopics', heading: 'Key Topics' },
  { key: 'talkingPoints', heading: 'Talking Points' },
  { key: 'actionItems', heading: 'Action Items' },
  { key: 'risks', heading: 'Risks & Concerns' },
];

const NESTED_SECTION_LABELS: Record<string, string> = {
  lastDeliveries: 'Last Deliveries',
  openItemsAndRisks: 'Open Items & Risks',
  recentAgreements: 'Recent Agreements',
  suggestedNextSteps: 'Suggested Next Steps',
  recommendedQuestions: 'Recommended Questions',
};

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => {
      if (typeof v === 'string') return v.trim();
      if (v && typeof v === 'object') return JSON.stringify(v);
      return String(v ?? '').trim();
    })
    .filter((s) => s.length > 0);
}

function asString(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}

export function formatBriefingAsMarkdown(meeting: MeetingSummary, briefing: Briefing): string {
  const lines: string[] = [];

  lines.push(`# ${meeting.title}`);
  const headerBits: string[] = [];
  if (meeting.client_name) headerBits.push(`**Client:** ${meeting.client_name}`);
  if (meeting.scheduled_at) headerBits.push(`**Scheduled:** ${meeting.scheduled_at}`);
  if (meeting.status) headerBits.push(`**Status:** ${meeting.status}`);
  if (headerBits.length) {
    lines.push('');
    lines.push(headerBits.join('  •  '));
  }

  let sectionsRendered = 0;

  for (const { key, heading } of STRING_SECTIONS) {
    const text = asString(briefing[key]);
    if (text) {
      lines.push('');
      lines.push(`## ${heading}`);
      lines.push('');
      lines.push(text);
      sectionsRendered++;
    }
  }

  for (const { key, heading } of LIST_SECTIONS) {
    const items = asStringList(briefing[key]);
    if (items.length) {
      lines.push('');
      lines.push(`## ${heading}`);
      lines.push('');
      for (const item of items) lines.push(`- ${item}`);
      sectionsRendered++;
    }
  }

  // Nested shape: briefing.sections.{lastDeliveries:{title,items},...}
  const nested = briefing.sections;
  if (nested && typeof nested === 'object') {
    for (const [key, value] of Object.entries(nested as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const section = value as { title?: unknown; items?: unknown };
      const heading = asString(section.title) || NESTED_SECTION_LABELS[key] || key;
      const items = asStringList(section.items);
      if (items.length === 0) continue;
      lines.push('');
      lines.push(`## ${heading}`);
      lines.push('');
      for (const item of items) lines.push(`- ${item}`);
      sectionsRendered++;
    }
  }

  if (sectionsRendered === 0) {
    lines.push('');
    lines.push('_No briefing content available._');
  }

  lines.push('');
  return lines.join('\n');
}
