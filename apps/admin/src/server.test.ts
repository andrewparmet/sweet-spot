import { describe, expect, it } from 'vitest';
import type { QueueRecord } from '../../../packages/shared/src/queue.ts';
import { paginateQueueWeeks, requireValidatedToken, validateSessionClaims } from './server.ts';

const NOW = Date.parse('2026-09-17T12:00:00Z');
const ACTIVE_ROLE = JSON.stringify({
  Role: 'ADM-MATCH',
  OrgID: 36,
  StartDate: '2021-06-17T00:00:00Z',
  EndDate: '2028-06-30T00:00:00Z'
});

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    exp: NOW / 1_000 + 3_600,
    nbf: NOW / 1_000 - 60,
    rtoRole: [ACTIVE_ROLE],
    ...overrides
  };
}

function queueRecord(submissionId: string, status: QueueRecord['status'], submittedAt: string): QueueRecord {
  return {
    submissionId,
    requestId: submissionId,
    submittedAt,
    matchDate: submittedAt.slice(0, 10),
    courtId: 36,
    matchType: 'S',
    side1Player1: 'Charlie Brown',
    side1Player2: '',
    side2Player1: 'Snoopy',
    side2Player2: '',
    scoreOriginal: '6-4',
    handicapEntryType: 'odds',
    handicapOriginal: '',
    tournament: false,
    status,
    scoreNormalized: '6/4',
    rtoPlayerIds: '',
    rtoHandicapDifference: '',
    rtoMatchId: '',
    lastError: '',
    updatedAt: submittedAt
  };
}

function week(tabName: string, records: readonly QueueRecord[]) {
  return { tabName, items: records.map(record => ({ tabName, record })) };
}

describe('requireValidatedToken', () => {
  it('returns the refreshed token from RTO', () => {
    expect(requireValidatedToken({ token: 'refreshed-token' })).toBe('refreshed-token');
    expect(requireValidatedToken({ Token: 'pascal-case-token' })).toBe('pascal-case-token');
  });

  it('rejects a missing returned token', () => {
    expect(() => requireValidatedToken({})).toThrow('RTO session is invalid');
  });
});

describe('validateSessionClaims', () => {
  it('accepts an active Boston match administrator', () => {
    expect(() => validateSessionClaims(claims(), NOW)).not.toThrow();
  });

  it('accepts a single serialized role', () => {
    expect(() => validateSessionClaims(claims({ rtoRole: ACTIVE_ROLE }), NOW)).not.toThrow();
  });

  it('rejects expired and not-yet-valid sessions', () => {
    expect(() => validateSessionClaims(claims({ exp: NOW / 1_000 }), NOW)).toThrow('session has expired');
    expect(() => validateSessionClaims(claims({ nbf: NOW / 1_000 + 1 }), NOW)).toThrow('session has expired');
  });

  it('rejects missing time claims', () => {
    expect(() => validateSessionClaims(claims({ exp: undefined }), NOW)).toThrow('session has expired');
    expect(() => validateSessionClaims(claims({ nbf: undefined }), NOW)).toThrow('session has expired');
  });

  it('rejects the wrong role or organization', () => {
    expect(() =>
      validateSessionClaims(claims({ rtoRole: JSON.stringify({ Role: 'ADM-ORG', OrgID: 36 }) }), NOW)
    ).toThrow('not a Boston match administrator');
    expect(() =>
      validateSessionClaims(claims({ rtoRole: JSON.stringify({ Role: 'ADM-MATCH', OrgID: 12 }) }), NOW)
    ).toThrow('not a Boston match administrator');
  });

  it('rejects malformed, missing, and expired roles', () => {
    expect(() => validateSessionClaims(claims({ rtoRole: '{' }), NOW)).toThrow('not a Boston match administrator');
    expect(() => validateSessionClaims(claims({ rtoRole: undefined }), NOW)).toThrow(
      'not a Boston match administrator'
    );
    expect(() =>
      validateSessionClaims(
        claims({ rtoRole: JSON.stringify({ Role: 'ADM-MATCH', OrgID: 36, EndDate: '2026-09-17T11:59:59Z' }) }),
        NOW
      )
    ).toThrow('not a Boston match administrator');
    expect(() =>
      validateSessionClaims(
        claims({ rtoRole: JSON.stringify({ Role: 'ADM-MATCH', OrgID: 36, StartDate: '2026-09-17T12:00:01Z' }) }),
        NOW
      )
    ).toThrow('not a Boston match administrator');
  });
});

describe('paginateQueueWeeks', () => {
  const weeks = [
    week('2026-W38', [
      queueRecord('review-new', 'Needs review', '2026-09-17T12:00:00-04:00'),
      queueRecord('history-new', 'Submitted', '2026-09-16T12:00:00-04:00')
    ]),
    week('2026-W37', [queueRecord('history-old', 'Withdrawn', '2026-09-10T12:00:00-04:00')]),
    week('2026-W36', [queueRecord('review-old', 'Failed', '2026-09-03T12:00:00-04:00')])
  ];

  it('returns the complete review queue', () => {
    const page = paginateQueueWeeks(weeks, 'review', 0);

    expect(page.items.map(item => item.record.submissionId)).toEqual(['review-new', 'review-old']);
    expect(page).toMatchObject({ page: 0, hasNext: false });
  });

  it('pages history by non-empty week, newest first', () => {
    expect(paginateQueueWeeks(weeks, 'history', 0)).toMatchObject({
      week: '2026-W38',
      page: 0,
      hasNext: true
    });
    expect(paginateQueueWeeks(weeks, 'history', 1)).toMatchObject({
      week: '2026-W37',
      page: 1,
      hasNext: false
    });
  });
});
