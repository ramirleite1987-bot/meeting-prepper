import { createHash } from 'node:crypto';

/**
 * Generates a deterministic meeting reference ID using SHA-256.
 * Same inputs always produce the same ID, enabling idempotent operations.
 */
export function generateMeetingId(clientId: string, date: string, title: string): string {
  const input = `${clientId}:${date}:${title}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * Generates a context hash for reconciliation/idempotency matching.
 * Used to detect duplicate action items across meeting sources.
 */
export function generateContextHash(meetingId: string, title: string): string {
  const normalized = title.trim().toLowerCase();
  const input = `${meetingId}:${normalized}`;
  return createHash('sha256').update(input).digest('hex');
}
