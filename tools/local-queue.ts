import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { QueueRecord } from '../packages/shared/src/queue.ts';
import { repositoryRoot } from './components.ts';

export const localDataDirectory = path.join(repositoryRoot, 'local-data');

export async function readLocalTabs(): Promise<Map<string, QueueRecord[]>> {
  await mkdir(localDataDirectory, { recursive: true });
  const filenames = (await readdir(localDataDirectory))
    .filter(filename => /^\d{4}-W\d{2}\.json$/.test(filename))
    .sort();
  const tabs = new Map<string, QueueRecord[]>();
  for (const filename of filenames) {
    const tabName = filename.replace(/\.json$/, '');
    const contents = await readFile(path.join(localDataDirectory, filename), 'utf8');
    tabs.set(tabName, JSON.parse(contents) as QueueRecord[]);
  }
  return tabs;
}

export async function writeLocalTab(tabName: string, records: readonly QueueRecord[]): Promise<void> {
  if (!/^\d{4}-W\d{2}$/.test(tabName)) {
    throw new Error(`Invalid weekly tab name: ${tabName}`);
  }
  await mkdir(localDataDirectory, { recursive: true });
  await writeFile(path.join(localDataDirectory, `${tabName}.json`), `${JSON.stringify(records, null, 2)}\n`);
}

export async function appendLocalRecord(tabName: string, record: QueueRecord): Promise<QueueRecord> {
  const tabs = await readLocalTabs();
  for (const records of tabs.values()) {
    const existing = records.find(candidate => candidate.requestId === record.requestId);
    if (existing) {
      return existing;
    }
  }

  const records = tabs.get(tabName) ?? [];
  await writeLocalTab(tabName, [...records, record]);
  return record;
}

export async function withdrawLocalRecord(submissionId: string, requestId: string, updatedAt: string): Promise<void> {
  const tabs = await readLocalTabs();
  for (const [tabName, records] of tabs) {
    const recordIndex = records.findIndex(
      record => record.submissionId === submissionId && record.requestId === requestId
    );
    if (recordIndex < 0) {
      continue;
    }
    const record = records[recordIndex];
    if (!record) {
      break;
    }
    if (record.status === 'Submitted') {
      throw new Error('That score has already been submitted to RTO and can no longer be undone here.');
    }
    records[recordIndex] = {
      ...record,
      status: 'Withdrawn',
      updatedAt
    };
    await writeLocalTab(tabName, records);
    return;
  }
  throw new Error('That submission could not be found.');
}

export async function demoSubmitLocalRecord(
  submissionId: string,
  playerIds: readonly string[],
  scoreNormalized: string,
  updatedAt: string,
  rtoMatchId: string
): Promise<void> {
  const tabs = await readLocalTabs();
  for (const [tabName, records] of tabs) {
    const recordIndex = records.findIndex(record => record.submissionId === submissionId);
    if (recordIndex < 0) {
      continue;
    }
    const record = records[recordIndex];
    if (!record) {
      break;
    }
    if (record.status === 'Submitted' || record.status === 'Withdrawn') {
      throw new Error('That score is not available for demo submission.');
    }
    records[recordIndex] = {
      ...record,
      status: 'Submitted',
      rtoPlayerIds: playerIds.join(','),
      scoreNormalized,
      rtoMatchId,
      lastError: '',
      updatedAt
    };
    await writeLocalTab(tabName, records);
    return;
  }
  throw new Error('That submission could not be found.');
}
