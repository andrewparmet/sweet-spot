import { describe, expect, it, vi } from 'vitest';
import type { AdminQueueItem, QueuePage, QueueRequest } from './api.ts';
import { createQueueModel, type QueueDependencies } from './queue-model.ts';

const item = { tabName: '2026-W38', record: { submissionId: 'submission-1' } } as AdminQueueItem;

function dependencies(overrides: Partial<QueueDependencies> = {}): QueueDependencies {
  return {
    loadAdminQueue: async request => ({ items: [item], page: request.page, hasNext: true, week: '2026-W38' }),
    isAuthenticationError: () => false,
    onAuthenticationError: () => undefined,
    ...overrides
  };
}

describe('createQueueModel', () => {
  it('loads the review queue without history paging', async () => {
    const queue = createQueueModel(dependencies());
    await queue.load();
    expect(queue.state.value).toMatchObject({ items: [item], page: 0, hasNext: false, week: '', loading: false });
    expect(queue.message.value).toBe('');
    expect(queue.showPagination.value).toBe(false);
  });

  it('pages through history', async () => {
    const requests: QueueRequest[] = [];
    const queue = createQueueModel(
      dependencies({
        loadAdminQueue: async request => {
          requests.push(request);
          return { items: [], page: request.page, hasNext: request.page < 1, week: '2026-W38' };
        }
      })
    );
    queue.selectView('history');
    await vi.waitFor(() => expect(queue.state.value.loading).toBe(false));
    queue.nextPage();
    await vi.waitFor(() => expect(queue.state.value.loading).toBe(false));
    expect(requests).toEqual([
      { view: 'history', page: 0 },
      { view: 'history', page: 1 }
    ]);
    expect(queue.state.value).toMatchObject({ page: 1, hasNext: false, week: '2026-W38' });
    expect(queue.message.value).toBe('No submission history yet.');
    expect(queue.showPagination.value).toBe(true);
  });

  it('shows a loading message and then the load error', async () => {
    let fail: (error: Error) => void = () => undefined;
    const queue = createQueueModel(
      dependencies({ loadAdminQueue: () => new Promise<QueuePage>((_, reject) => (fail = reject)) })
    );
    const loading = queue.load();
    expect(queue.message.value).toBe('Loading queue…');
    fail(new Error('The sheet is unavailable.'));
    await loading;
    expect(queue.message.value).toBe('The sheet is unavailable.');
  });

  it('hands authentication errors to the session', async () => {
    const onAuthenticationError = vi.fn();
    const queue = createQueueModel(
      dependencies({
        loadAdminQueue: async () => {
          throw new Error('Sign in again.');
        },
        isAuthenticationError: () => true,
        onAuthenticationError
      })
    );
    await queue.load();
    expect(onAuthenticationError).toHaveBeenCalledWith('Sign in again.');
  });

  it('ignores a load that finishes after the queue is reset', async () => {
    let finish: (page: QueuePage) => void = () => undefined;
    const queue = createQueueModel(dependencies({ loadAdminQueue: () => new Promise(resolve => (finish = resolve)) }));
    const loading = queue.load();
    queue.reset();
    finish({ items: [item], page: 0, hasNext: false, week: '' });
    await loading;
    expect(queue.state.value.items).toEqual([]);
  });
});
