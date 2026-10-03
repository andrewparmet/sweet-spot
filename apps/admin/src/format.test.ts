import { describe, expect, it } from 'vitest';
import type { QueueRecord } from '../../../packages/shared/src/queue.ts';
import { isDeletable, isReviewable, wasRejectedByRto } from './format.ts';

function record(status: QueueRecord['status'], lastError: string): QueueRecord {
  return { status, lastError } as QueueRecord;
}

describe('isReviewable', () => {
  it('reopens reconciliation rows only when RTO rejected them', () => {
    const rejected = record(
      'Needs reconciliation',
      'RTO returned HTTP 409 without a readable match ID. Reconcile in RTO.'
    );
    const timedOut = record(
      'Needs reconciliation',
      'RTO returned HTTP 408 without a readable match ID. Reconcile in RTO.'
    );
    const unknown = record(
      'Needs reconciliation',
      'RTO returned HTTP 502; the submission outcome is unknown. Reconcile in RTO.'
    );
    expect([rejected, timedOut, unknown].map(wasRejectedByRto)).toEqual([true, false, false]);
    expect([rejected, timedOut, unknown].map(isReviewable)).toEqual([true, false, false]);
    expect(isReviewable(record('Failed', 'RTO rejected the match.'))).toBe(true);
    expect(isReviewable(record('Submitted', ''))).toBe(false);
  });
});

describe('isDeletable', () => {
  it('allows history rows and rejected rows but not unknown RTO outcomes', () => {
    expect(isDeletable(record('Submitted', ''))).toBe(true);
    expect(isDeletable(record('Withdrawn', ''))).toBe(true);
    expect(isDeletable(record('Needs reconciliation', 'RTO returned HTTP 400 without a readable match ID. x'))).toBe(
      true
    );
    expect(
      isDeletable(record('Needs reconciliation', 'RTO returned HTTP 502; the submission outcome is unknown.'))
    ).toBe(false);
  });
});
