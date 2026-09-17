import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isValidOdds } from '../../../packages/shared/src/match.ts';
import {
  escapeForSheet,
  isoWeekTabName,
  normalizeScore,
  validateSubmission,
  validateUndoSubmission
} from './server.ts';

describe('validateSubmission', () => {
  it('accepts singles and discards hidden partners', () => {
    const result = validateSubmission({
      requestId: 'request-1',
      clientId: 'client-1',
      matchType: 'S',
      side1Player1: ' Andrew   Parmet ',
      side1Player2: 'Hidden Partner',
      side2Player1: 'Larry Wenglin',
      side2Player2: 'Other Hidden Partner',
      score: '6-2, 6-1',
      handicapType: 'odds',
      handicap: '-15 / 15',
      tournament: false
    });

    expect(result.side1Player1).toBe('Andrew Parmet');
    expect(result.side1Player2).toBe('');
    expect(result.side2Player2).toBe('');
  });

  it('accepts compact score and odds input without spaces', () => {
    const result = validateSubmission({
      requestId: 'request-compact',
      clientId: 'client-1',
      matchType: 'S',
      side1Player1: 'Andrew Parmet',
      side2Player1: 'Larry Wenglin',
      score: '6-2,6-1',
      handicapType: 'odds',
      handicap: '-15/15',
      tournament: false
    });

    expect(result.score).toBe('6-2,6-1');
    expect(result.handicap).toBe('-15/15');
  });

  it('accepts a level match without handicap input', () => {
    const result = validateSubmission({
      requestId: 'request-level',
      clientId: 'client-1',
      matchType: 'S',
      side1Player1: 'Joe Cool',
      side2Player1: 'J Cool',
      score: '6-4,6-3',
      handicapType: 'odds',
      handicap: '',
      tournament: false
    });

    expect(result.handicap).toBe('');
  });

  it('requires both doubles partners', () => {
    expect(() =>
      validateSubmission({
        requestId: 'request-2',
        clientId: 'client-1',
        matchType: 'D',
        side1Player1: 'Player One',
        side1Player2: '',
        side2Player1: 'Player Three',
        side2Player2: 'Player Four',
        score: '6-4',
        handicapType: 'difference',
        handicap: '12',
        tournament: true
      })
    ).toThrow('Enter both doubles partners.');
  });

  it('validates numeric handicap differences', () => {
    expect(() =>
      validateSubmission({
        requestId: 'request-3',
        clientId: 'client-1',
        matchType: 'S',
        side1Player1: 'Player One',
        side2Player1: 'Player Two',
        score: '10-8',
        handicapType: 'difference',
        handicap: 'owe 15',
        tournament: false
      })
    ).toThrow('Enter the handicap difference as a number.');
  });

  it('rejects blank required match data', () => {
    expect(() =>
      validateSubmission({
        requestId: 'request-blank',
        clientId: 'client-1',
        matchType: 'S',
        side1Player1: 'Joe Cool',
        side2Player1: 'J Cool',
        score: '   ',
        handicapType: 'odds',
        handicap: '-15/15',
        tournament: false
      })
    ).toThrow('Score is required.');
  });

  it('rejects invalid odds', () => {
    expect(() =>
      validateSubmission({
        requestId: 'request-invalid-odds',
        clientId: 'client-1',
        matchType: 'S',
        side1Player1: 'Joe Cool',
        side2Player1: 'J Cool',
        score: '6-2,6-1',
        handicapType: 'odds',
        handicap: '10',
        tournament: false
      })
    ).toThrow('Enter two valid odds scores');
  });
});

describe('odds validation', () => {
  it.each(['0/0', '15/0', '30/40', '-15/15', '-30/q15', '-h 15/30', '-h15/15', 'q15/40', '-q15/h30'])(
    'accepts %s',
    odds => {
      expect(isValidOdds(odds)).toBe(true);
    }
  );

  it.each(['10', '15', '10/15', '-40/0', 'half15/15', '-half15/15', 'h0/15', '15//0'])('rejects %s', odds => {
    expect(isValidOdds(odds)).toBe(false);
  });
});

describe('validateUndoSubmission', () => {
  it('requires both identifiers', () => {
    expect(
      validateUndoSubmission({
        submissionId: 'submission-1',
        requestId: 'request-1'
      })
    ).toEqual({
      submissionId: 'submission-1',
      requestId: 'request-1'
    });
    expect(() => validateUndoSubmission({ submissionId: 'submission-1' })).toThrow('Request ID is required.');
  });
});

describe('score normalization', () => {
  it('normalizes common separators without constraining the format', () => {
    expect(normalizeScore(' 6-2,  6–1, 3—2 ')).toBe('6/2 6/1 3/2');
    expect(normalizeScore('6-2,6-1')).toBe('6/2 6/1');
    expect(normalizeScore('10-8')).toBe('10/8');
  });
});

describe('Sheet storage', () => {
  it('protects cells from formula injection', () => {
    expect(escapeForSheet('=IMPORTDATA("https://example.com")')).toBe('\'=IMPORTDATA("https://example.com")');
    expect(escapeForSheet('-16')).toBe("'-16");
    expect(escapeForSheet('Andrew Parmet')).toBe('Andrew Parmet');
  });

  it('uses ISO week tabs across year boundaries', () => {
    expect(isoWeekTabName('2026-09-17')).toBe('2026-W38');
    expect(isoWeekTabName('2027-01-01')).toBe('2026-W53');
    expect(isoWeekTabName('2027-01-04')).toBe('2027-W01');
  });
});

describe('player view', () => {
  it('contains only requested player-facing fields', () => {
    const html = readFileSync(path.join(import.meta.dirname, 'index.html'), 'utf8');
    const expectedNames = [
      'matchType',
      'side1Player1',
      'side1Player2',
      'side2Player1',
      'side2Player2',
      'score',
      'handicapType',
      'handicap',
      'tournament',
      'website'
    ];
    const names = Array.from(html.matchAll(/<input[^>]+\bname="([^"]+)"/g), match => match[1]);

    expect(Array.from(new Set(names))).toEqual(expectedNames);
    expect(html).not.toMatch(/Match date|Court ID|Description|Weighting/i);
  });
});
