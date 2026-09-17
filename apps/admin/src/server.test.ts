import { describe, expect, it } from 'vitest';
import { requireValidatedToken, validateSessionClaims } from './server.ts';

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
