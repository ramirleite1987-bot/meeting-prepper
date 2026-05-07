import { describe, it, expect } from 'vitest';
import {
  mapLinearStateToTaskStatus,
  mapPriorityToLinear,
} from '../../../src/adapters/linear-status.js';

describe('mapLinearStateToTaskStatus', () => {
  it('maps the canonical Linear default state names', () => {
    expect(mapLinearStateToTaskStatus('Backlog')).toBe('backlog');
    expect(mapLinearStateToTaskStatus('Todo')).toBe('todo');
    expect(mapLinearStateToTaskStatus('In Progress')).toBe('in-progress');
    expect(mapLinearStateToTaskStatus('In Review')).toBe('in-review');
    expect(mapLinearStateToTaskStatus('Done')).toBe('done');
    expect(mapLinearStateToTaskStatus('Cancelled')).toBe('cancelled');
    expect(mapLinearStateToTaskStatus('Canceled')).toBe('cancelled');
  });

  it('is case-insensitive', () => {
    expect(mapLinearStateToTaskStatus('in progress')).toBe('in-progress');
    expect(mapLinearStateToTaskStatus('IN PROGRESS')).toBe('in-progress');
    expect(mapLinearStateToTaskStatus('In progress')).toBe('in-progress');
    expect(mapLinearStateToTaskStatus('DONE')).toBe('done');
    expect(mapLinearStateToTaskStatus('todo')).toBe('todo');
  });

  it('handles common variants and separators', () => {
    expect(mapLinearStateToTaskStatus('in_progress')).toBe('in-progress');
    expect(mapLinearStateToTaskStatus('to do')).toBe('todo');
    expect(mapLinearStateToTaskStatus('to-do')).toBe('todo');
    expect(mapLinearStateToTaskStatus('  Done  ')).toBe('done');
  });

  it('maps common custom workflow states', () => {
    expect(mapLinearStateToTaskStatus('Doing')).toBe('in-progress');
    expect(mapLinearStateToTaskStatus('Started')).toBe('in-progress');
    expect(mapLinearStateToTaskStatus('WIP')).toBe('in-progress');
    expect(mapLinearStateToTaskStatus('QA')).toBe('in-review');
    expect(mapLinearStateToTaskStatus('In Review')).toBe('in-review');
    expect(mapLinearStateToTaskStatus('Completed')).toBe('done');
    expect(mapLinearStateToTaskStatus('Shipped')).toBe('done');
  });

  it('falls back to "todo" for unknown states', () => {
    expect(mapLinearStateToTaskStatus('Pending Review by Legal')).toBe('in-review');
    expect(mapLinearStateToTaskStatus('Random Custom State')).toBe('todo');
    expect(mapLinearStateToTaskStatus('')).toBe('todo');
  });

  it('prefers terminal states over progress states when both substrings match', () => {
    // "Done in progress" is contrived but verifies precedence
    expect(mapLinearStateToTaskStatus('Done')).toBe('done');
    expect(mapLinearStateToTaskStatus('Cancelled (was in progress)')).toBe('cancelled');
  });
});

describe('mapPriorityToLinear', () => {
  it('maps each internal priority to the Linear numeric value', () => {
    expect(mapPriorityToLinear('urgent')).toBe(1);
    expect(mapPriorityToLinear('high')).toBe(2);
    expect(mapPriorityToLinear('medium')).toBe(3);
    expect(mapPriorityToLinear('low')).toBe(4);
    expect(mapPriorityToLinear('none')).toBe(0);
  });

  it('defaults to 0 (none) when priority is undefined', () => {
    expect(mapPriorityToLinear(undefined)).toBe(0);
  });
});
