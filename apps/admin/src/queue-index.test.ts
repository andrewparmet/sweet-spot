import { describe, expect, it } from 'vitest';
import type { QueueRecord } from '../../../packages/shared/src/queue.ts';
import {
  loadQueuePage,
  parseQueueIndex,
  QUEUE_INDEX_MAX_AGE_MS,
  QUEUE_INDEX_VERSION,
  withHistoryTab,
  type QueueIndex
} from './queue-index.ts';

const NOW = Date.parse('2026-09-27T12:00:00Z');

function queueRecord(submissionId: string, status: QueueRecord['status'], submittedAt: string): QueueRecord {
  return {
    submissionId,
    requestId: submissionId,
    submittedAt,
    matchDate: submittedAt.slice(0, 10),
    courtId: 36,
    matchType: 'S',
    side1Player1: 'Charlie Brown',
    side1Player2: '',
    side2Player1: 'Lucy van Pelt',
    side2Player2: '',
    scoreOriginal: '6-4',
    handicapEntryType: 'odds',
    handicapOriginal: '',
    tournament: false,
    status,
    scoreNormalized: '6/4',
    rtoPlayerIds: '',
    rtoHandicapDifference: '',
    rtoMatchId: '',
    lastError: '',
    updatedAt: submittedAt,
    sanctioned: false
  };
}

function spreadsheet(tabs: Record<string, QueueRecord[]>) {
  const reads: string[] = [];
  return {
    reads,
    tabs: {
      names: Object.keys(tabs),
      read: (tabName: string) => {
        reads.push(tabName);
        return tabs[tabName] ?? [];
      }
    }
  };
}

function index(overrides: Partial<QueueIndex> = {}): QueueIndex {
  return {
    version: QUEUE_INDEX_VERSION,
    builtAt: NOW - 60_000,
    watermark: '2026-W38',
    pendingTabs: [],
    historyTabs: [],
    ...overrides
  };
}

const weeks = {
  '2026-W36': [queueRecord('review-old', 'Failed', '2026-09-03T12:00:00-04:00')],
  '2026-W37': [queueRecord('history-old', 'Withdrawn', '2026-09-10T12:00:00-04:00')],
  '2026-W38': [
    queueRecord('review-new', 'Needs review', '2026-09-17T12:00:00-04:00'),
    queueRecord('history-new', 'Submitted', '2026-09-16T12:00:00-04:00')
  ]
};

describe('loadQueuePage', () => {
  it('leaves deleted records out of both views', () => {
    const { tabs } = spreadsheet({
      '2026-W38': [
        queueRecord('deleted-review', 'Deleted', '2026-09-17T12:00:00-04:00'),
        queueRecord('history-new', 'Submitted', '2026-09-16T12:00:00-04:00')
      ]
    });
    const review = loadQueuePage(tabs, undefined, 'review', 0, NOW);
    const history = loadQueuePage(tabs, undefined, 'history', 0, NOW);

    expect(review.page.items).toEqual([]);
    expect(review.index.pendingTabs).toEqual([]);
    expect(history.page.items.map(item => item.record.submissionId)).toEqual(['history-new']);
  });

  it('builds the index from every tab when none exists', () => {
    const { tabs, reads } = spreadsheet(weeks);
    const result = loadQueuePage(tabs, undefined, 'review', 0, NOW);

    expect(result.page.items.map(item => item.record.submissionId)).toEqual(['review-new', 'review-old']);
    expect(result.page).toMatchObject({ page: 0, hasNext: false });
    expect(reads.sort()).toEqual(['2026-W36', '2026-W37', '2026-W38']);
    expect(result.index).toEqual({
      version: QUEUE_INDEX_VERSION,
      builtAt: NOW,
      watermark: '2026-W38',
      pendingTabs: ['2026-W36', '2026-W38'],
      historyTabs: ['2026-W37', '2026-W38']
    });
  });

  it('reads only pending tabs and the newest tab for review', () => {
    const { tabs, reads } = spreadsheet(weeks);
    const result = loadQueuePage(
      tabs,
      index({ pendingTabs: ['2026-W36', '2026-W38'], historyTabs: ['2026-W37', '2026-W38'] }),
      'review',
      0,
      NOW
    );

    expect(reads.sort()).toEqual(['2026-W36', '2026-W38']);
    expect(result.page.items.map(item => item.record.submissionId)).toEqual(['review-new', 'review-old']);
  });

  it('keeps an old pending score in the review queue across weeks', () => {
    const { tabs } = spreadsheet({ ...weeks, '2026-W39': [] });
    const result = loadQueuePage(
      tabs,
      index({ pendingTabs: ['2026-W36', '2026-W38'], historyTabs: ['2026-W37', '2026-W38'] }),
      'review',
      0,
      NOW
    );

    expect(result.page.items.map(item => item.record.submissionId)).toEqual(['review-new', 'review-old']);
    expect(result.index.watermark).toBe('2026-W39');
  });

  it('rereads the tab at the watermark so late submissions to that week appear', () => {
    const { tabs } = spreadsheet({
      '2026-W38': [queueRecord('late', 'Needs review', '2026-09-20T23:59:00-04:00')],
      '2026-W39': []
    });
    const result = loadQueuePage(tabs, index({ watermark: '2026-W38' }), 'review', 0, NOW);

    expect(result.page.items.map(item => item.record.submissionId)).toEqual(['late']);
    expect(result.index.pendingTabs).toEqual(['2026-W38']);
  });

  it('drops a tab from the pending list once it has nothing left to review', () => {
    const { tabs } = spreadsheet({
      '2026-W37': [queueRecord('done', 'Submitted', '2026-09-10T12:00:00-04:00')],
      '2026-W38': []
    });
    const result = loadQueuePage(tabs, index({ pendingTabs: ['2026-W37'] }), 'review', 0, NOW);

    expect(result.index).toMatchObject({ pendingTabs: [], historyTabs: ['2026-W37'] });
  });

  it('reads only the requested history week', () => {
    const { tabs, reads } = spreadsheet(weeks);
    const result = loadQueuePage(
      tabs,
      index({ pendingTabs: ['2026-W36', '2026-W38'], historyTabs: ['2026-W37', '2026-W38'] }),
      'history',
      1,
      NOW
    );

    expect(reads.sort()).toEqual(['2026-W37', '2026-W38']);
    expect(result.page).toEqual({
      items: [{ tabName: '2026-W37', record: weeks['2026-W37'][0] }],
      page: 1,
      hasNext: false,
      week: '2026-W37'
    });
  });

  it('pages history by non-empty week, newest first', () => {
    const { tabs } = spreadsheet(weeks);
    expect(loadQueuePage(tabs, undefined, 'history', 0, NOW).page).toMatchObject({
      week: '2026-W38',
      page: 0,
      hasNext: true
    });
    expect(loadQueuePage(tabs, undefined, 'history', 2, NOW).page).toEqual({ items: [], page: 2, hasNext: false });
  });

  it('rebuilds an expired or outdated index', () => {
    for (const stale of [index({ builtAt: NOW - QUEUE_INDEX_MAX_AGE_MS }), index({ version: 0 })]) {
      const { tabs, reads } = spreadsheet(weeks);
      const result = loadQueuePage(tabs, stale, 'review', 0, NOW);
      expect(reads).toHaveLength(3);
      expect(result.index.builtAt).toBe(NOW);
    }
  });

  it('forgets tabs that no longer exist', () => {
    const { tabs } = spreadsheet({ '2026-W38': [] });
    const result = loadQueuePage(
      tabs,
      index({ pendingTabs: ['2026-W30'], historyTabs: ['2026-W30'] }),
      'review',
      0,
      NOW
    );
    expect(result.index).toMatchObject({ pendingTabs: [], historyTabs: [] });
  });
});

describe('withHistoryTab', () => {
  it('adds a tab once, in order', () => {
    const updated = withHistoryTab(index({ historyTabs: ['2026-W36', '2026-W38'] }), '2026-W37');
    expect(updated.historyTabs).toEqual(['2026-W36', '2026-W37', '2026-W38']);
    expect(withHistoryTab(updated, '2026-W37')).toBe(updated);
  });
});

describe('parseQueueIndex', () => {
  it('round-trips a stored index', () => {
    const stored = index({ pendingTabs: ['2026-W38'] });
    expect(parseQueueIndex(JSON.stringify(stored))).toEqual(stored);
  });

  it('ignores missing, unreadable, and outdated indexes', () => {
    expect(parseQueueIndex(null)).toBeUndefined();
    expect(parseQueueIndex('{')).toBeUndefined();
    expect(parseQueueIndex(JSON.stringify({ ...index(), version: 0 }))).toBeUndefined();
    expect(parseQueueIndex(JSON.stringify({ ...index(), pendingTabs: [1] }))).toBeUndefined();
  });
});
