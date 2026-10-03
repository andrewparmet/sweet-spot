import { describe, expect, it } from 'vitest';
import type { AdminEntryRequest } from './api.ts';
import { createEntryModel, firstInvalidEntryField, type EntryDependencies, type EntryDraft } from './entry-model.ts';

const TODAY = '2026-10-03';

function dependencies(overrides: Partial<EntryDependencies> = {}): EntryDependencies {
  let nextId = 0;
  return {
    randomId: () => `id-${++nextId}`,
    today: () => TODAY,
    submitAdminEntry: async () => undefined,
    ...overrides
  };
}

function fill(model: ReturnType<typeof createEntryModel>): void {
  model.updateDraft({ side1Player1: 'Charlie Brown', side2Player1: 'Snoopy', score: '6-2,6-1' });
}

describe('createEntryModel', () => {
  it('submits the date and sanctioned flag, then clears the players for the next score', async () => {
    const requests: AdminEntryRequest[] = [];
    const model = createEntryModel(dependencies({ submitAdminEntry: async request => void requests.push(request) }));
    fill(model);
    model.updateDraft({ matchDate: '2026-09-28' });
    model.setSanctioned(true);
    expect(await model.submit()).toBe('submitted');
    expect(requests).toEqual([
      {
        matchType: 'S',
        matchDate: '2026-09-28',
        side1Player1: 'Charlie Brown',
        side1Player2: '',
        side2Player1: 'Snoopy',
        side2Player2: '',
        score: '6-2,6-1',
        handicap: '',
        handicapType: 'odds',
        tournament: true,
        sanctioned: true,
        requestId: 'id-1'
      }
    ]);
    expect(model.state.value).toMatchObject({
      draft: { matchDate: '2026-09-28', sanctioned: true, side1Player1: '', score: '', requestId: 'id-2' },
      submitting: false,
      message: { kind: 'notice', text: 'Added Charlie Brown vs Snoopy to Needs review.' }
    });
  });

  it('accepts several scores in a row', async () => {
    const requests: AdminEntryRequest[] = [];
    const model = createEntryModel(dependencies({ submitAdminEntry: async request => void requests.push(request) }));
    fill(model);
    await model.submit();
    fill(model);
    await model.submit();
    expect(requests.map(request => request.requestId)).toEqual(['id-1', 'id-2']);
  });

  it('clears sanctioned when tournament is unchecked', () => {
    const model = createEntryModel(dependencies());
    model.setSanctioned(true);
    model.setTournament(false);
    expect(model.state.value.draft).toMatchObject({ tournament: false, sanctioned: false });
  });

  it('keeps the draft and request ID when submission fails', async () => {
    const model = createEntryModel(
      dependencies({
        submitAdminEntry: async () => {
          throw new Error('The queue is locked.');
        }
      })
    );
    fill(model);
    expect(await model.submit()).toBe('failed');
    expect(model.state.value).toMatchObject({
      draft: { side1Player1: 'Charlie Brown', requestId: 'id-1' },
      message: { kind: 'error', text: 'The queue is locked.' }
    });
  });
});

describe('firstInvalidEntryField', () => {
  const draft: EntryDraft = {
    matchType: 'D',
    matchDate: TODAY,
    side1Player1: 'Charlie Brown',
    side1Player2: '',
    side2Player1: 'Snoopy',
    side2Player2: 'Woodstock',
    score: '6-2',
    handicap: '',
    tournament: false,
    sanctioned: false,
    requestId: 'id-1'
  };

  it('requires doubles partners and a past or present date', () => {
    expect(firstInvalidEntryField(draft, TODAY)?.field).toBe('side1Player2');
    expect(firstInvalidEntryField({ ...draft, side1Player2: 'Linus', matchDate: '2026-10-04' }, TODAY)).toEqual({
      field: 'matchDate',
      message: 'The match date cannot be in the future.'
    });
  });
});
