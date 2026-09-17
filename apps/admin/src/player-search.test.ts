import { describe, expect, it } from 'vitest';
import { playerMatchScore } from './player-search.ts';

describe('playerMatchScore', () => {
  it('prefers an exact full name', () => {
    expect(playerMatchScore('Joe Cool', 'Joe Cool')).toBeLessThan(playerMatchScore('Joe Cool', 'Joseph Cool'));
  });

  it('recognizes a first initial and last name', () => {
    expect(playerMatchScore('J Cool', 'Joe Cool')).toBeLessThan(playerMatchScore('J Cool', 'James Cook'));
  });

  it('ignores accents and punctuation', () => {
    expect(playerMatchScore('J D Arcy', "J. D'Arcy")).toBeLessThan(playerMatchScore('J D Arcy', 'John Darcy'));
  });

  it('ranks a minor typo above an unrelated name', () => {
    expect(playerMatchScore('Joe Col', 'Joe Cool')).toBeLessThan(playerMatchScore('Joe Col', 'John Cole'));
  });
});
