import { describe, expect, it, vi } from 'vitest';
import type { QueueRecord } from '../../../packages/shared/src/queue.ts';
import type { AdminQueueItem, DirectoryPlayer, ReviewedMatchRequest } from './api.ts';
import { createReviewModel, playerOptions, type ReviewDependencies, type ReviewForm } from './review-model.ts';

const charlie: DirectoryPlayer = { id: '1', name: 'Charlie Brown', handicap: 42.5, isBoston: true };
const lucy: DirectoryPlayer = { id: '2', name: 'Lucy van Pelt', handicap: 30, isBoston: true };
const linus: DirectoryPlayer = { id: '3', name: 'Linus van Pelt', handicap: 55, isBoston: false };
const boston = [charlie, lucy];

const record: QueueRecord = {
  submissionId: 'submission-1',
  requestId: 'request-1',
  submittedAt: '2026-09-20T12:00:00Z',
  matchDate: '2026-09-20',
  courtId: 1,
  matchType: 'S',
  side1Player1: 'C Brown',
  side1Player2: '',
  side2Player1: 'Linus',
  side2Player2: '',
  scoreOriginal: '6-2,6-1',
  handicapEntryType: 'odds',
  handicapOriginal: '',
  tournament: false,
  status: 'Needs review',
  scoreNormalized: '',
  rtoPlayerIds: '',
  rtoHandicapDifference: '',
  rtoMatchId: '',
  lastError: '',
  updatedAt: '',
  sanctioned: false
};
const item: AdminQueueItem = { tabName: '2026-W38', record };

function dependencies(overrides: Partial<ReviewDependencies> = {}): ReviewDependencies {
  return {
    loadBostonPlayers: async () => boston,
    expandPlayerSearch: async () => [linus],
    loadSanctionedMatches: async () => [{ id: '7', description: '2026 US Open' }],
    submitReviewedMatch: async () => undefined,
    onSubmitted: () => undefined,
    ...overrides
  };
}

function form(state: unknown): ReviewForm {
  const current = state as ReviewForm;
  expect(['editing', 'submitting']).toContain(current.phase);
  return current;
}

describe('createReviewModel', () => {
  it('preselects the best Boston match for each entered player', async () => {
    const review = createReviewModel(dependencies());
    await review.open(item);
    const { slots, score } = form(review.state.value);
    expect(score).toBe('6-2,6-1');
    expect(slots.map(slot => [slot.side, slot.originalName, slot.selectedId])).toEqual([
      [1, 'C Brown', '1'],
      [2, 'Linus', '']
    ]);
    expect(review.canSubmit.value).toBe(false);
  });

  it('expands the directory search and selects the wider match', async () => {
    const expandPlayerSearch = vi.fn(async () => [linus]);
    const review = createReviewModel(dependencies({ expandPlayerSearch }));
    await review.open(item);
    await review.expand(1);
    const slot = form(review.state.value).slots[1];
    expect(expandPlayerSearch).toHaveBeenCalledWith('S', 'Linus');
    expect(slot?.expansion).toBe('expanded');
    expect(slot?.selectedId).toBe('3');
    expect(review.canSubmit.value).toBe(true);
  });

  it('restores the expand action and reports a failed search', async () => {
    const review = createReviewModel(
      dependencies({
        expandPlayerSearch: async () => {
          throw new Error('RTO is down.');
        }
      })
    );
    await review.open(item);
    await review.expand(1);
    const current = form(review.state.value);
    expect(current.slots[1]?.expansion).toBe('idle');
    expect(current.error).toBe('RTO is down.');
  });

  it('requires a manual search query', async () => {
    const review = createReviewModel(dependencies());
    await review.open(item);
    review.setManualQuery(1, '  ');
    await review.searchManually(1);
    expect(form(review.state.value).error).toBe('Enter a player name to search.');
  });

  it('submits the selected players and score, then closes', async () => {
    const requests: ReviewedMatchRequest[] = [];
    const onSubmitted = vi.fn();
    const review = createReviewModel(
      dependencies({ submitReviewedMatch: async request => void requests.push(request), onSubmitted })
    );
    await review.open(item);
    review.selectPlayer(1, '2');
    review.setScore(' 6-3 ');
    review.setHandicap(' -15/15 ');
    await review.submit();
    expect(requests).toEqual([
      {
        submissionId: 'submission-1',
        tabName: '2026-W38',
        players: [
          { id: '1', handicap: 42.5 },
          { id: '2', handicap: 30 }
        ],
        score: '6-3',
        handicap: '-15/15',
        sanctionedMatch: ''
      }
    ]);
    expect(review.state.value.phase).toBe('closed');
    expect(onSubmitted).toHaveBeenCalledOnce();
  });

  it('starts from the entered handicap and blocks invalid overrides', async () => {
    const review = createReviewModel(dependencies());
    await review.open({ ...item, record: { ...record, handicapOriginal: '-h15/15' } });
    review.selectPlayer(1, '2');
    expect(form(review.state.value).handicap).toBe('-h15/15');
    expect(review.canSubmit.value).toBe(true);
    review.setHandicap('-16');
    expect(review.canSubmit.value).toBe(false);
    review.setHandicap('');
    expect(review.canSubmit.value).toBe(true);
  });

  it('requires a sanctioned match choice for sanctioned scores', async () => {
    const requests: ReviewedMatchRequest[] = [];
    const review = createReviewModel(
      dependencies({ submitReviewedMatch: async request => void requests.push(request) })
    );
    await review.open({ ...item, record: { ...record, tournament: true, sanctioned: true } });
    review.selectPlayer(1, '2');
    expect(form(review.state.value).sanctionedMatches).toEqual([{ id: '7', description: '2026 US Open' }]);
    expect(review.canSubmit.value).toBe(false);
    review.selectSanctionedMatch('2026 US Open');
    await review.submit();
    expect(requests[0]?.sanctionedMatch).toBe('2026 US Open');
  });

  it('stays open and ignores close requests while submitting', async () => {
    let finish: () => void = () => undefined;
    const review = createReviewModel(
      dependencies({ submitReviewedMatch: () => new Promise(resolve => (finish = resolve)) })
    );
    await review.open(item);
    review.selectPlayer(1, '2');
    const submission = review.submit();
    expect(review.state.value.phase).toBe('submitting');
    review.close();
    expect(review.state.value.phase).toBe('submitting');
    finish();
    await submission;
    expect(review.state.value.phase).toBe('closed');
  });

  it('keeps the form editable when submission fails', async () => {
    const review = createReviewModel(
      dependencies({
        submitReviewedMatch: async () => {
          throw new Error('RTO rejected the match.');
        }
      })
    );
    await review.open(item);
    review.selectPlayer(1, '2');
    await review.submit();
    const current = form(review.state.value);
    expect(current.phase).toBe('editing');
    expect(current.error).toBe('RTO rejected the match.');
  });

  it('reports a directory that fails to load', async () => {
    const review = createReviewModel(
      dependencies({
        loadBostonPlayers: async () => {
          throw new Error('Sign in again.');
        }
      })
    );
    await review.open(item);
    expect(review.state.value).toEqual({ phase: 'failed', item, error: 'Sign in again.' });
  });

  it('ignores a directory load for a review that was closed', async () => {
    let finish: (players: DirectoryPlayer[]) => void = () => undefined;
    const review = createReviewModel(
      dependencies({ loadBostonPlayers: () => new Promise(resolve => (finish = resolve)) })
    );
    const opening = review.open(item);
    review.close();
    finish(boston);
    await opening;
    expect(review.state.value.phase).toBe('closed');
  });
});

describe('playerOptions', () => {
  it('groups Boston players ahead of the wider directory and picks the best match from either', () => {
    expect(playerOptions('Linus van Pelt', boston, [linus])).toEqual({
      boston: [lucy],
      wider: [linus],
      bestMatchId: '3'
    });
  });

  it('reports no best match when nothing is reasonable', () => {
    expect(playerOptions('Peppermint Patty', boston, []).bestMatchId).toBeUndefined();
  });
});
