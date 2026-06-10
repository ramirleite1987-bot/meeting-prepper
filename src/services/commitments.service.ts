/**
 * Commitments Service for the Client Briefing Generator.
 * Tracks the "promises ledger": which open action items belong to our side
 * vs the client's side, across all of a client's previous meetings, so the
 * next briefing can surface anything at risk of being dropped.
 */

import { config } from '../config.js';
import { queries } from '../db/index.js';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export type OwnerSide = 'ours' | 'theirs' | 'unknown';

export interface OutstandingCommitment {
  id: string;
  title: string;
  owner: string | null;
  ownerSide: OwnerSide;
  status: string;
  deadline: string | null;
  meetingId: string;
  meetingTitle: string;
  meetingScheduledAt: string | null;
}

// ──────────────────────────────────────────────
// Owner-side classification
// ──────────────────────────────────────────────

function selfIdentifiers(): string[] {
  const fromConfig = (config.selfIdentifiers ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  // The configured Google account is always one of "our" identities.
  if (config.gogAccount) {
    fromConfig.push(config.gogAccount.trim().toLowerCase());
  }
  return fromConfig;
}

/**
 * Classify an action-item owner as our side or the client's side.
 * Matches case-insensitively against SELF_IDENTIFIERS (and GOG_ACCOUNT);
 * a partial match in either direction counts so "Ramir" matches
 * "ramirleite1987@gmail.com" entries and vice versa.
 */
export function classifyOwnerSide(owner: string | null | undefined): OwnerSide {
  const normalized = owner?.trim().toLowerCase();
  if (!normalized) return 'unknown';

  const identifiers = selfIdentifiers();
  if (identifiers.length === 0) return 'unknown';

  const isOurs = identifiers.some(
    (id) => id === normalized || normalized.includes(id) || id.includes(normalized),
  );
  return isOurs ? 'ours' : 'theirs';
}

// ──────────────────────────────────────────────
// Service
// ──────────────────────────────────────────────

export class CommitmentsService {
  /**
   * Open (not completed/cancelled) action items from the client's *other*
   * meetings — the commitments made before the meeting being prepared.
   */
  getOutstandingCommitments(clientId: string, excludeMeetingId: string): OutstandingCommitment[] {
    const rows = queries.getOutstandingCommitmentsByClient().all({
      clientId,
      excludeMeetingId,
    }) as Array<Record<string, unknown>>;

    return rows.map((row) => {
      const storedSide = row.owner_side as OwnerSide | undefined;
      const ownerSide =
        storedSide && storedSide !== 'unknown'
          ? storedSide
          : classifyOwnerSide(row.owner as string | null);

      return {
        id: row.id as string,
        title: row.title as string,
        owner: (row.owner as string | null) ?? null,
        ownerSide,
        status: row.status as string,
        deadline: (row.deadline as string | null) ?? null,
        meetingId: row.meeting_id as string,
        meetingTitle: row.meeting_title as string,
        meetingScheduledAt: (row.meeting_scheduled_at as string | null) ?? null,
      };
    });
  }

  /**
   * Format commitments as briefing section lines, ours first —
   * unfulfilled promises we made are the ones that hurt most.
   */
  formatAsBriefingItems(commitments: OutstandingCommitment[], limit = 10): string[] {
    const label: Record<OwnerSide, string> = {
      ours: 'We promised',
      theirs: 'They promised',
      unknown: 'Open',
    };
    const order: Record<OwnerSide, number> = { ours: 0, theirs: 1, unknown: 2 };

    return [...commitments]
      .sort((a, b) => order[a.ownerSide] - order[b.ownerSide])
      .slice(0, limit)
      .map((c) => {
        const owner = c.owner ? ` — ${c.owner}` : '';
        const due = c.deadline ? `, due ${c.deadline.slice(0, 10)}` : '';
        return `${label[c.ownerSide]}: ${c.title}${owner} (from "${c.meetingTitle}"${due})`;
      });
  }
}
