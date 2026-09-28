import { describe, expect, it } from 'vitest';
import { directorySearchTerms, playerMatchScore, reasonablePlayerMatches } from './player-search.ts';

describe('playerMatchScore', () => {
  it('prefers an exact full name', () => {
    expect(playerMatchScore('Charlie Brown', 'Charlie Brown')).toBeLessThan(
      playerMatchScore('Charlie Brown', 'Charles Brown')
    );
  });

  it('recognizes a first initial and last name', () => {
    expect(playerMatchScore('C Brown', 'Charlie Brown')).toBeLessThan(playerMatchScore('C Brown', 'Chris Browne'));
  });

  it('recognizes a first name and last initial', () => {
    expect(playerMatchScore('Charlie B', 'Charlie Brown')).toBeLessThan(playerMatchScore('Charlie B', 'Charles Brown'));
    expect(playerMatchScore('Charlie B', 'Charlie Brown')).toBeLessThan(playerMatchScore('Charlie B', 'Charlie Adams'));
  });

  it('recognizes a last name by itself', () => {
    expect(playerMatchScore('Brown', 'Charlie Brown')).toBeLessThan(playerMatchScore('Brown', 'Chris Brow'));
  });

  it('recognizes the suffix of a compound last name', () => {
    expect(playerMatchScore('G Cookson', 'George Sawrey-Cookson [G-Monies]')).toBeLessThan(
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
    expect(playerMatchScore('Charlie Brwn', 'Charlie Brown')).toBeLessThan(
      playerMatchScore('Charlie Brwn', 'Charles Bryan')
    );
  });
});

describe('reasonablePlayerMatches', () => {
  const players = [
    { name: 'George Sawrey-Cookson [G-Monies]' },
    { name: 'Seb Sawrey-Cookson' },
    { name: 'Hugh Cook' },
    { name: 'Andrew Parmet' }
  ];

  it('keeps strong fuzzy matches and removes unrelated players', () => {
    expect(reasonablePlayerMatches('G Cookson', players)).toEqual([{ name: 'George Sawrey-Cookson [G-Monies]' }]);
  });

  it('allows a close typo', () => {
    expect(reasonablePlayerMatches('Goerge Sawrey Cookson', players)[0]).toEqual({
      name: 'George Sawrey-Cookson [G-Monies]'
    });
  });

  it('returns no candidates for an unrelated name', () => {
    expect(reasonablePlayerMatches('Peppermint Patty', players)).toEqual([]);
  });

  it('ranks a first name and last initial first', () => {
    const peanuts = [{ name: 'Charlie Adams' }, { name: 'Charles Brown' }, { name: 'Charlie Brown' }];
    expect(reasonablePlayerMatches('Charlie B', peanuts)[0]).toEqual({ name: 'Charlie Brown' });
  });

  it('caps broad matches', () => {
    const andrews = Array.from({ length: 20 }, (_, index) => ({ name: `Andrew Player ${index}` }));
    expect(reasonablePlayerMatches('Andrew', andrews)).toHaveLength(12);
  });
});

describe('directorySearchTerms', () => {
  it('searches a first initial and last name by last name', () => {
    expect(directorySearchTerms('C Brown')).toEqual(['C Brown', 'Brown']);
  });

  it('searches a first name and last initial by first name', () => {
    expect(directorySearchTerms('Charlie B')).toEqual(['Charlie B', 'Charlie']);
    expect(directorySearchTerms('Charlie B.')).toEqual(['Charlie B.', 'Charlie']);
  });

  it('does not repeat a single name', () => {
    expect(directorySearchTerms('Brown')).toEqual(['Brown']);
  });
});
