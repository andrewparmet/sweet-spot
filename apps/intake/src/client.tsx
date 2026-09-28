import { render } from 'preact';
import { randomId, submitMatch, undoSubmission } from './api.ts';
import { createMatchEntryModel } from './match-entry-model.ts';
import { MatchEntry } from './match-entry.tsx';

const root = document.getElementById('app');
if (!root) {
  throw new Error('Missing element: app');
}
render(
  <MatchEntry model={createMatchEntryModel({ storage: localStorage, randomId, submitMatch, undoSubmission })} />,
  root
);
