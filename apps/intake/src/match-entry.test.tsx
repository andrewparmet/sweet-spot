import { renderToString } from 'preact-render-to-string';
import { describe, expect, it } from 'vitest';
import { createMatchEntryModel } from './match-entry-model.ts';
import { MatchEntry } from './match-entry.tsx';

function renderedForm(): string {
  const model = createMatchEntryModel({
    storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    randomId: () => 'id',
    submitMatch: async () => ({ submissionId: 'submission-1', accepted: true }),
    undoSubmission: async () => ({ withdrawn: true })
  });
  return renderToString(<MatchEntry model={model} />);
}

describe('MatchEntry', () => {
  it('contains only requested player-facing fields', () => {
    const html = renderedForm();
    const names = Array.from(html.matchAll(/<input[^>]+\bname="([^"]+)"/g), match => match[1]);

    expect(Array.from(new Set(names))).toEqual([
      'matchType',
      'side1Player1',
      'side1Player2',
      'side2Player1',
      'side2Player2',
      'score',
      'handicap',
      'tournament',
      'website'
    ]);
    expect(html).not.toMatch(/Match date|Court ID|Description|Weighting/i);
  });

  it('labels the result and handicap entry rules', () => {
    const html = renderedForm();
    expect(html).toContain('<legend>Result (omit spaces)</legend>');
    expect(html).toContain('<legend>Handicap (optional)</legend>');
  });
});
