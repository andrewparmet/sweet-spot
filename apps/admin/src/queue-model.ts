import { computed, signal } from '@preact/signals';
import type { AdminQueueItem, QueuePage, QueueRequest, QueueView } from './api.ts';

export interface QueueState {
  readonly view: QueueView;
  readonly items: readonly AdminQueueItem[];
  readonly page: number;
  readonly hasNext: boolean;
  readonly week: string;
  readonly loading: boolean;
  readonly error: string | undefined;
}

export interface QueueDependencies {
  readonly loadAdminQueue: (request: QueueRequest) => Promise<QueuePage>;
  readonly isAuthenticationError: (error: unknown) => boolean;
  readonly onAuthenticationError: (message: string) => void;
}

export type QueueModel = ReturnType<typeof createQueueModel>;

const initialState: QueueState = {
  view: 'review',
  items: [],
  page: 0,
  hasNext: false,
  week: '',
  loading: false,
  error: undefined
};

export function createQueueModel(dependencies: QueueDependencies) {
  const state = signal<QueueState>(initialState);
  const message = computed(() => {
    const { view, items, loading, error } = state.value;
    if (loading) {
      return 'Loading queue…';
    }
    if (error) {
      return error;
    }
    if (items.length > 0) {
      return '';
    }
    return view === 'history' ? 'No submission history yet.' : 'No scores need review.';
  });
  const showPagination = computed(
    () => state.value.view === 'history' && (state.value.page > 0 || state.value.hasNext)
  );
  let latestLoad = 0;

  async function load(page = state.value.view === 'history' ? state.value.page : 0): Promise<void> {
    const loadId = ++latestLoad;
    const { view } = state.value;
    state.value = { ...state.value, items: [], loading: true, error: undefined };
    try {
      const result = await dependencies.loadAdminQueue({ view, page });
      if (loadId !== latestLoad) {
        return;
      }
      const history = view === 'history';
      state.value = {
        ...state.value,
        items: result.items,
        page: history ? result.page : 0,
        hasNext: history && result.hasNext,
        week: history ? result.week : '',
        loading: false
      };
    } catch (error) {
      if (loadId !== latestLoad) {
        return;
      }
      if (dependencies.isAuthenticationError(error)) {
        dependencies.onAuthenticationError(error instanceof Error ? error.message : 'Sign in again.');
        return;
      }
      state.value = {
        ...state.value,
        items: [],
        loading: false,
        error: error instanceof Error ? error.message : 'The queue could not be loaded.'
      };
    }
  }

  function selectView(view: QueueView): void {
    if (state.value.view === view) {
      return;
    }
    state.value = { ...initialState, view };
    void load(0);
  }

  function previousPage(): void {
    void load(Math.max(0, state.value.page - 1));
  }

  function nextPage(): void {
    void load(state.value.page + 1);
  }

  function reset(): void {
    latestLoad += 1;
    state.value = initialState;
  }

  return { state, message, showPagination, load, selectView, previousPage, nextPage, reset };
}
