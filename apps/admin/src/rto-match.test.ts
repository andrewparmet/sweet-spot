import { describe, expect, it } from 'vitest';
import { resolvePlayedHandicapDifference } from './rto-match.ts';

const rows = [
  { hcapDifference: 0, oddsShort1: 'love', oddsShort2: 'love' },
  { hcapDifference: 15, oddsShort1: 'rec 15', oddsShort2: 'owe 15' },
  { hcapDifference: 16, oddsShort1: 'rec 15', oddsShort2: 'owe 15' },
  { hcapDifference: 20, oddsShort1: 'rec h15', oddsShort2: 'owe h15' }
];

describe('resolvePlayedHandicapDifference', () => {
  it('uses the calculated difference to disambiguate an odds range', () => {
    expect(resolvePlayedHandicapDifference('15/-15', rows, 15.8)).toBe(16);
    expect(resolvePlayedHandicapDifference('15/-15', rows, 15.1)).toBe(15);
  });

  it('reverses the difference when side one owes', () => {
    expect(resolvePlayedHandicapDifference('-15/15', rows, -15.8)).toBe(-16);
  });

  it('supports half and quarter notation from RTO', () => {
    expect(
      resolvePlayedHandicapDifference(
        '-h15/h15',
        [{ hcapDifference: 20, oddsShort1: 'rec ½ 15', oddsShort2: 'owe ½ 15' }],
        -20
      )
    ).toBe(-20);
  });

  it('rejects odds absent from the RTO table', () => {
    expect(() => resolvePlayedHandicapDifference('-30/30', rows, -30)).toThrow('Enter the difference instead');
  });
});
