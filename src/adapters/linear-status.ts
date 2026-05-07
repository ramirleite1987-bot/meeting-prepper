/**
 * Canonical mappings between Linear's workflow vocabulary and the
 * internal TaskStatus / priority representation. Imported by both
 * the Linear adapter (outbound) and the webhook handler (inbound)
 * so they cannot drift apart.
 *
 * Matching is case-insensitive and fuzzy-substring based: real-world
 * Linear workspaces have custom workflow state names ("Doing", "QA",
 * "Shipped") and casing/spelling variations ("In Progress", "in
 * progress", "in_progress"). An exact-match table would silently
 * fall through to a default and lose updates; this implementation
 * trades a tiny bit of ambiguity for resilience.
 */

import type { ActionItem, TaskStatus } from './types.js';

/**
 * Map a Linear workflow state name (any casing, any custom variant)
 * to the internal TaskStatus.
 *
 * Unknown states fall back to 'todo'.
 */
export function mapLinearStateToTaskStatus(stateName: string): TaskStatus {
  const lower = stateName.toLowerCase().trim();

  if (lower.includes('backlog')) return 'backlog';
  if (lower.includes('cancel')) return 'cancelled';
  if (lower.includes('done') || lower.includes('complet') || lower.includes('shipped')) {
    return 'done';
  }
  if (lower.includes('review') || lower.includes('qa')) return 'in-review';
  if (
    lower.includes('in progress') ||
    lower.includes('in_progress') ||
    lower.includes('started') ||
    lower.includes('doing') ||
    lower.includes('wip')
  ) {
    return 'in-progress';
  }
  if (lower.includes('todo') || lower.includes('to do') || lower.includes('to-do')) {
    return 'todo';
  }

  return 'todo';
}

/**
 * Map internal priority to Linear's numeric priority.
 * Linear: 0=none, 1=urgent, 2=high, 3=medium, 4=low.
 */
export function mapPriorityToLinear(priority?: ActionItem['priority']): number {
  switch (priority) {
    case 'urgent':
      return 1;
    case 'high':
      return 2;
    case 'medium':
      return 3;
    case 'low':
      return 4;
    case 'none':
    default:
      return 0;
  }
}
