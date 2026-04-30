/**
 * Calendar adapter for the Client Briefing Generator.
 * Reads an ICS file from a configured path, parses calendar events,
 * and filters by date range and client name matching.
 */

import { readFile, access } from 'node:fs/promises';
import type { IContextAdapter, ContextEntry } from './types.js';

interface CalendarEvent {
  summary: string;
  description: string;
  start: Date;
  end: Date;
  location?: string;
  uid?: string;
}

function parseICSDate(value: string): Date {
  // Handle YYYYMMDDTHHMMSSZ and YYYYMMDDTHHMMSS formats
  const cleaned = value.replace(/[^0-9T]/g, '');
  const match = cleaned.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (match) {
    const [, y, m, d, h, min, s] = match;
    const isUTC = value.endsWith('Z');
    if (isUTC) {
      return new Date(Date.UTC(+y, +m - 1, +d, +h, +min, +s));
    }
    return new Date(+y, +m - 1, +d, +h, +min, +s);
  }

  // Handle YYYYMMDD (all-day events)
  const dateMatch = cleaned.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateMatch) {
    const [, y, m, d] = dateMatch;
    return new Date(+y, +m - 1, +d);
  }

  return new Date(value);
}

function unfoldLines(raw: string): string[] {
  // ICS uses line folding: continuation lines start with a space or tab
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n');
}

function parseICS(raw: string): CalendarEvent[] {
  const lines = unfoldLines(raw);
  const events: CalendarEvent[] = [];
  let current: Partial<CalendarEvent> | null = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      current = {};
      continue;
    }

    if (line === 'END:VEVENT' && current) {
      if (current.summary && current.start) {
        events.push({
          summary: current.summary,
          description: current.description ?? '',
          start: current.start,
          end: current.end ?? current.start,
          location: current.location,
          uid: current.uid,
        });
      }
      current = null;
      continue;
    }

    if (!current) continue;

    // Extract property name and value (handle parameters like DTSTART;TZID=...)
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const propPart = line.slice(0, colonIdx);
    const value = line.slice(colonIdx + 1).trim();
    const propName = propPart.split(';')[0].toUpperCase();

    switch (propName) {
      case 'SUMMARY':
        current.summary = value;
        break;
      case 'DESCRIPTION':
        current.description = value.replace(/\\n/g, '\n').replace(/\\,/g, ',');
        break;
      case 'DTSTART':
        current.start = parseICSDate(value);
        break;
      case 'DTEND':
        current.end = parseICSDate(value);
        break;
      case 'LOCATION':
        current.location = value;
        break;
      case 'UID':
        current.uid = value;
        break;
    }
  }

  return events;
}

export class CalendarAdapter implements IContextAdapter {
  readonly name = 'calendar';
  readonly source = 'calendar';

  private icsPath: string | undefined;

  constructor(icsPath?: string) {
    this.icsPath = icsPath ?? process.env.CALENDAR_ICS_PATH;
  }

  async initialize(): Promise<void> {
    // ICS path is resolved lazily; nothing to initialize
  }

  async isAvailable(): Promise<boolean> {
    if (!this.icsPath) return false;
    try {
      await access(this.icsPath);
      return true;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {
    // No persistent connections to clean up
  }

  async getClientContext(
    clientName: string,
    options?: { since?: Date; limit?: number },
  ): Promise<ContextEntry[]> {
    if (!(await this.isAvailable())) {
      return [];
    }

    const raw = await readFile(this.icsPath!, 'utf-8');
    const events = parseICS(raw);
    const pattern = clientName.toLowerCase();
    const entries: ContextEntry[] = [];

    for (const event of events) {
      const summaryMatch = event.summary.toLowerCase().includes(pattern);
      const descMatch = event.description.toLowerCase().includes(pattern);

      if (!summaryMatch && !descMatch) continue;

      if (options?.since && event.start < options.since) continue;

      entries.push({
        source: this.source,
        type: 'event',
        title: event.summary,
        content: event.description || event.summary,
        timestamp: event.start,
        metadata: {
          end: event.end.toISOString(),
          ...(event.location ? { location: event.location } : {}),
          ...(event.uid ? { uid: event.uid } : {}),
        },
      });

      if (options?.limit && entries.length >= options.limit) break;
    }

    return entries;
  }
}
