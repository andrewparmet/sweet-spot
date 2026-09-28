import type { QueueRecord } from '../../../packages/shared/src/queue.ts';

export const QUEUE_INDEX_VERSION = 1;
export const QUEUE_INDEX_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export type QueueView = 'review' | 'history';

export interface AdminQueueItem {
  readonly tabName: string;
  readonly record: QueueRecord;
}

export interface QueuePage {
  readonly items: AdminQueueItem[];
  readonly page: number;
  readonly hasNext: boolean;
  readonly week?: string;
}

/**
 * Summary of which week tabs hold pending and history records.
 *
 * Tabs older than `watermark` that appear in neither list are known to be empty. Tabs at or after the watermark are
 * always reread, because new submissions only land in the current week's tab.
 */
export interface QueueIndex {
  readonly version: number;
  readonly builtAt: number;
  readonly watermark: string;
  readonly pendingTabs: readonly string[];
  readonly historyTabs: readonly string[];
}

export interface QueueTabs {
  readonly names: readonly string[];
  readonly read: (tabName: string) => readonly QueueRecord[];
}

export interface IndexedQueuePage {
  readonly page: QueuePage;
  readonly index: QueueIndex;
}

export function isHistoryRecord(record: QueueRecord): boolean {
  return record.status === 'Submitted' || record.status === 'Withdrawn';
}

/**
 * Loads one queue page, reading only the week tabs `index` cannot rule out, and returns the updated index.
 *
 * A missing, outdated, or expired `index` is rebuilt by reading every tab.
 */
export function loadQueuePage(
  tabs: QueueTabs,
  index: QueueIndex | undefined,
  view: QueueView,
  page: number,
  now: number
): IndexedQueuePage {
  const names = [...tabs.names].sort();
  const existing = new Set(names);
  const current =
    index?.version === QUEUE_INDEX_VERSION && now - index.builtAt < QUEUE_INDEX_MAX_AGE_MS ? index : undefined;
  const pendingTabs = new Set(current?.pendingTabs.filter(name => existing.has(name)));
  const historyTabs = new Set(current?.historyTabs.filter(name => existing.has(name)));
  const readTabs = new Map<string, readonly QueueRecord[]>();

  const summarize = (name: string): readonly QueueRecord[] => {
    const cached = readTabs.get(name);
    if (cached) {
      return cached;
    }
    const records = tabs.read(name);
    readTabs.set(name, records);
    toggle(
      pendingTabs,
      name,
      records.some(record => !isHistoryRecord(record))
    );
    toggle(historyTabs, name, records.some(isHistoryRecord));
    return records;
  };

  for (const name of names) {
    if (!current || name >= current.watermark) {
      summarize(name);
    }
  }

  let queuePage: QueuePage;
  if (view === 'review') {
    for (const name of names.filter(name => pendingTabs.has(name))) {
      summarize(name);
    }
    const items = [...readTabs]
      .flatMap(([tabName, records]) =>
        records.filter(record => !isHistoryRecord(record)).map(record => ({ tabName, record }))
      )
      .sort((left, right) => right.record.submittedAt.localeCompare(left.record.submittedAt));
    queuePage = { items, page: 0, hasNext: false };
  } else {
    const selectedTab = names.filter(name => historyTabs.has(name)).reverse()[page];
    const items = selectedTab
      ? summarize(selectedTab)
          .filter(isHistoryRecord)
          .map(record => ({ tabName: selectedTab, record }))
          .sort((left, right) => right.record.submittedAt.localeCompare(left.record.submittedAt))
      : [];
    queuePage = {
      items,
      page,
      hasNext: names.filter(name => historyTabs.has(name)).length > page + 1,
      ...(selectedTab ? { week: selectedTab } : {})
    };
  }

  return {
    page: queuePage,
    index: {
      version: QUEUE_INDEX_VERSION,
      builtAt: current?.builtAt ?? now,
      watermark: names.at(-1) ?? '',
      pendingTabs: names.filter(name => pendingTabs.has(name)),
      historyTabs: names.filter(name => historyTabs.has(name))
    }
  };
}

/**
 * Records that a record in `tabName` reached a history status outside a queue load.
 */
export function withHistoryTab(index: QueueIndex, tabName: string): QueueIndex {
  if (index.historyTabs.includes(tabName)) {
    return index;
  }
  return { ...index, historyTabs: [...index.historyTabs, tabName].sort() };
}

export function parseQueueIndex(serialized: string | null): QueueIndex | undefined {
  if (!serialized) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(serialized);
    if (
      typeof value === 'object' &&
      value !== null &&
      Reflect.get(value, 'version') === QUEUE_INDEX_VERSION &&
      typeof Reflect.get(value, 'builtAt') === 'number' &&
      typeof Reflect.get(value, 'watermark') === 'string' &&
      isStringArray(Reflect.get(value, 'pendingTabs')) &&
      isStringArray(Reflect.get(value, 'historyTabs'))
    ) {
      return value as QueueIndex;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function toggle(set: Set<string>, value: string, included: boolean): void {
  if (included) {
    set.add(value);
  } else {
    set.delete(value);
  }
}
