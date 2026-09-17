import { describe, expect, it } from 'vitest';
import { playerMatchScore, reasonablePlayerMatches } from './player-search.ts';

describe('playerMatchScore', () => {
  it('prefers an exact full name', () => {
    expect(playerMatchScore('Joe Cool', 'Joe Cool')).toBeLessThan(playerMatchScore('Joe Cool', 'Joseph Cool'));
  });

  it('recognizes a first initial and last name', () => {
    expect(playerMatchScore('J Cool', 'Joe Cool')).toBeLessThan(playerMatchScore('J Cool', 'James Cook'));
  });

  it('recognizes a last name by itself', () => {
    expect(playerMatchScore('Cool', 'Joe Cool')).toBeLessThan(playerMatchScore('Cool', 'James Cook'));
  });

  it('recognizes the suffix of a compound last name', () => {
    expect(playerMatchScore('G Cookson', 'George Sawrey-Cookson')).toBeLessThan(
      playerMatchScore('G Cookson', 'George Cook')
    );
    expect(playerMatchScore('Cookson', 'George Sawrey-Cookson')).toBeLessThan(
      playerMatchScore('Cookson', 'George Cook')
    );
  });

  it('ignores accents and punctuation', () => {
    expect(playerMatchScore('J D Arcy', "J. D'Arcy")).toBeLessThan(playerMatchScore('J D Arcy', 'John Darcy'));
  });

  it('ranks a minor typo above an unrelated name', () => {
    expect(playerMatchScore('Joe Col', 'Joe Cool')).toBeLessThan(playerMatchScore('Joe Col', 'John Cole'));
  });
});

describe('reasonablePlayerMatches', () => {
  const players = [
    { name: 'George Sawrey-Cookson' },
    { name: 'Seb Sawrey-Cookson' },
    { name: 'Hugh Cook' },
    { name: 'Andrew Parmet' }
  ];

  it('keeps strong fuzzy matches and removes unrelated players', () => {
    expect(reasonablePlayerMatches('G Cookson', players)).toEqual([{ name: 'George Sawrey-Cookson' }]);
  });

  it('allows a close typo', () => {
    expect(reasonablePlayerMatches('Goerge Sawrey Cookson', players)[0]).toEqual({ name: 'George Sawrey-Cookson' });
  });

  it('returns no candidates for an unrelated name', () => {
    expect(reasonablePlayerMatches('Peppermint Patty', players)).toEqual([]);
  });

  it('caps broad matches', () => {
    const andrews = Array.from({ length: 20 }, (_, index) => ({ name: `Andrew Player ${index}` }));
    expect(reasonablePlayerMatches('Andrew', andrews)).toHaveLength(12);
  });
});
