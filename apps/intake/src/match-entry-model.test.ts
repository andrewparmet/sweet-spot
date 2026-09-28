import { describe, expect, it, vi } from 'vitest';
import type { MatchSubmissionRequest, UndoSubmissionRequest } from '../../../packages/shared/src/match.ts';
import {
  createMatchEntryModel,
  DRAFT_KEY,
  firstInvalidField,
  type Draft,
  type MatchEntryDependencies
} from './match-entry-model.ts';

const completeDraft: Draft = {
  matchType: 'S',
  side1Player1: 'Charlie Brown',
  side1Player2: '',
  side2Player1: 'C Brown',
  side2Player2: '',
  score: '6-2,6-1',
  handicap: '',
  tournament: false,
  requestId: 'request-1'
};

function memoryStorage(entries: Record<string, string> = {}): MatchEntryDependencies['storage'] {
  const values = new Map(Object.entries(entries));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: key => void values.delete(key)
  };
}

function dependencies(overrides: Partial<MatchEntryDependencies> = {}): MatchEntryDependencies {
  let nextId = 0;
  return {
    storage: memoryStorage({ [DRAFT_KEY]: JSON.stringify(completeDraft) }),
    randomId: () => `id-${++nextId}`,
    submitMatch: async () => ({ submissionId: 'submission-1', accepted: true }),
    undoSubmission: async () => ({ withdrawn: true }),
    ...overrides
  };
}

describe('firstInvalidField', () => {
  it('asks for the first missing player in form order', () => {
    expect(firstInvalidField({ ...completeDraft, side1Player1: ' ', score: '' })).toEqual({
      field: 'side1Player1',
      message: 'Enter the Side 1 player.'
    });
  });

  it('requires partners only for doubles', () => {
    expect(firstInvalidField(completeDraft)).toBeUndefined();
    expect(firstInvalidField({ ...completeDraft, matchType: 'D' })).toEqual({
      field: 'side1Player2',
      message: 'Enter the Side 1 partner.'
    });
  });

  it('validates the score format', () => {
    expect(firstInvalidField({ ...completeDraft, score: 'won easily' })?.message).toBe(
      'Enter game scores like 6-2,6-1 or 10-8.'
    );
  });

  it('accepts only odds for the handicap', () => {
    expect(firstInvalidField({ ...completeDraft, handicap: '-15/15' })).toBeUndefined();
    expect(firstInvalidField({ ...completeDraft, handicap: '-16' })).toEqual({
      field: 'handicap',
      message: 'Enter two valid odds scores, such as -15/15 or -h15/15.'
    });
  });
});

describe('createMatchEntryModel', () => {
  it('restores a saved draft and ignores invalid choices', () => {
    const storage = memoryStorage({
      [DRAFT_KEY]: JSON.stringify({ matchType: 'X', side1Player1: 'Charlie B', tournament: 'yes' })
    });
    const model = createMatchEntryModel(dependencies({ storage }));
    expect(model.state.value.draft).toEqual({
      ...completeDraft,
      side1Player1: 'Charlie B',
      side2Player1: '',
      score: '',
      requestId: 'id-1'
    });
  });

  it('discards an unreadable draft', () => {
    const storage = memoryStorage({ [DRAFT_KEY]: '{' });
    createMatchEntryModel(dependencies({ storage }));
    expect(storage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('saves the draft and clears the field error on every edit', async () => {
    const storage = memoryStorage();
    const model = createMatchEntryModel(dependencies({ storage }));
    expect(await model.submit()).toBe('invalid');
    expect(model.state.value.fieldError?.field).toBe('side1Player1');
    model.updateDraft({ side1Player1: 'Charlie Brown' });
    expect(model.state.value.fieldError).toBeUndefined();
    expect(JSON.parse(storage.getItem(DRAFT_KEY) ?? '{}')).toMatchObject({ side1Player1: 'Charlie Brown' });
  });

  it('submits the draft with the client ID and offers an undo', async () => {
    const payloads: MatchSubmissionRequest[] = [];
    const deps = dependencies({
      submitMatch: async payload => {
        payloads.push(payload);
        return { submissionId: 'submission-1', accepted: true };
      }
    });
    const model = createMatchEntryModel(deps);
    expect(await model.submit()).toBe('submitted');
    expect(payloads).toEqual([{ ...completeDraft, handicapType: 'odds', website: '', clientId: 'id-1' }]);
    expect(model.state.value.submission).toEqual({
      phase: 'submitted',
      draft: completeDraft,
      receipt: { submissionId: 'submission-1', requestId: 'request-1' }
    });
    expect(deps.storage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('keeps the request ID when a submission fails so a retry is idempotent', async () => {
    const submitMatch = vi.fn(async () => {
      throw new Error('');
    });
    const model = createMatchEntryModel(dependencies({ submitMatch }));
    expect(await model.submit()).toBe('failed');
    expect(model.state.value.submission.phase).toBe('editing');
    expect(model.state.value.message).toEqual({
      kind: 'error',
      text: 'The score could not be submitted. Try again.'
    });
    expect(model.state.value.draft.requestId).toBe('request-1');
  });

  it('restores the submitted draft with a new request ID after undo', async () => {
    const undoRequests: UndoSubmissionRequest[] = [];
    const deps = dependencies({ undoSubmission: async request => (undoRequests.push(request), { withdrawn: true }) });
    const model = createMatchEntryModel(deps);
    await model.submit();
    expect(await model.undo()).toBe('undone');
    expect(undoRequests).toEqual([{ submissionId: 'submission-1', requestId: 'request-1' }]);
    expect(model.state.value).toMatchObject({
      draft: { ...completeDraft, requestId: 'id-2' },
      submission: { phase: 'editing' },
      message: { kind: 'notice', text: 'Submission undone. Make any changes, then submit again.' }
    });
    expect(JSON.parse(deps.storage.getItem(DRAFT_KEY) ?? '{}')).toMatchObject({ requestId: 'id-2' });
  });

  it('keeps the undo available when undo fails', async () => {
    const model = createMatchEntryModel(
      dependencies({
        undoSubmission: async () => {
          throw new Error('The queue is locked.');
        }
      })
    );
    await model.submit();
    expect(await model.undo()).toBe('failed');
    expect(model.state.value.submission.phase).toBe('submitted');
    expect(model.state.value.message).toEqual({ kind: 'error', text: 'The queue is locked.' });
  });
});
