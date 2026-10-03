import { describe, expect, it } from 'vitest';
import { recentWeekTabNames } from './queue-sheet.ts';

describe('recentWeekTabNames', () => {
  it('returns this week and last week, across a year boundary', () => {
    expect(recentWeekTabNames('2026-10-03')).toEqual(['2026-W40', '2026-W39']);
    expect(recentWeekTabNames('2027-01-04')).toEqual(['2027-W01', '2026-W53']);
  });
});
