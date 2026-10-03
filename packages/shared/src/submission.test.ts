import { describe, expect, it } from 'vitest';
import { validateMatchDate } from './submission.ts';

describe('validateMatchDate', () => {
  it('accepts today and recent past dates', () => {
    expect(validateMatchDate('2026-10-03', '2026-10-03')).toBe('2026-10-03');
    expect(validateMatchDate(' 2026-09-28 ', '2026-10-03')).toBe('2026-09-28');
  });

  it.each([
    ['2026-10-04', 'cannot be in the future'],
    ['2026-07-04', 'within the last 90 days'],
    ['2026-02-30', 'valid match date'],
    ['10/01/2026', 'valid match date'],
    ['', 'valid match date']
  ])('rejects %s', (matchDate, message) => {
    expect(() => validateMatchDate(matchDate, '2026-10-03')).toThrow(message);
  });
});
