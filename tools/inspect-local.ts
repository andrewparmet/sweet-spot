import { readLocalTabs } from './local-queue.ts';

const tabs = await readLocalTabs();
const pending = Array.from(tabs.entries()).flatMap(([tabName, records]) =>
  records
    .filter(record => record.status !== 'Submitted' && record.status !== 'Withdrawn')
    .map(record => ({ tabName, record }))
);

console.log('Weekly tabs');
for (const [tabName, records] of tabs) {
  const pendingCount = records.filter(record => record.status !== 'Submitted' && record.status !== 'Withdrawn').length;
  console.log(`${tabName}: ${records.length} total, ${pendingCount} pending`);
}

console.log('\nCross-tab admin inbox');
for (const { tabName, record } of pending) {
  const side1 = [record.side1Player1, record.side1Player2].filter(Boolean).join(' / ');
  const side2 = [record.side2Player1, record.side2Player2].filter(Boolean).join(' / ');
  console.log(`${tabName} | ${record.status.padEnd(12)} | ${side1} vs ${side2} | ${record.scoreOriginal}`);
}
