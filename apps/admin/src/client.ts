import type { QueueRecord } from '../../../packages/shared/src/queue.ts';

interface AdminQueueItem {
  readonly tabName: string;
  readonly record: QueueRecord;
}

interface DirectoryPlayer {
  readonly id: string;
  readonly name: string;
  readonly handicap: number;
}

type QueueView = 'review' | 'history';

const DIRECTORY_CACHE_KEY = 'sweet-spot-demo-directory-v1';
const queueMessage = requiredElement<HTMLElement>('queue-message');
const queueList = requiredElement<HTMLElement>('queue-list');
const refreshButton = requiredElement<HTMLButtonElement>('refresh-button');
const reviewTab = requiredElement<HTMLButtonElement>('review-tab');
const historyTab = requiredElement<HTMLButtonElement>('history-tab');
const reviewDialog = requiredElement<HTMLDialogElement>('review-dialog');
const closeDialogButton = requiredElement<HTMLButtonElement>('close-dialog');
const cancelDialogButton = requiredElement<HTMLButtonElement>('cancel-dialog');
const demoSubmitButton = requiredElement<HTMLButtonElement>('demo-submit');
const dialogLoading = requiredElement<HTMLElement>('dialog-loading');
const loadingLabel = requiredElement<HTMLElement>('loading-label');
const dialogContent = requiredElement<HTMLElement>('dialog-content');
const dialogMatch = requiredElement<HTMLElement>('dialog-match');
const playerMatches = requiredElement<HTMLElement>('player-matches');
const dialogError = requiredElement<HTMLElement>('dialog-error');
const dialogActions = requiredElement<HTMLElement>('dialog-actions');

let allItems: AdminQueueItem[] = [];
let activeView: QueueView = 'review';
let selectedItem: AdminQueueItem | undefined;

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element: ${id}`);
  }
  return element as T;
}

function teamName(record: QueueRecord, side: 1 | 2): string {
  const players = side === 1 ? [record.side1Player1, record.side1Player2] : [record.side2Player1, record.side2Player2];
  return players.filter(Boolean).join(' / ');
}

function playerNames(record: QueueRecord): string[] {
  return [record.side1Player1, record.side1Player2, record.side2Player1, record.side2Player2].filter(Boolean);
}

function textElement(tagName: keyof HTMLElementTagNameMap, className: string, text: string): HTMLElement {
  const element = document.createElement(tagName);
  element.className = className;
  element.textContent = text;
  return element;
}

function statusClass(status: QueueRecord['status']): string {
  return `status status-${status.toLowerCase().replaceAll(' ', '-')}`;
}

function formatMatchDate(matchDate: string): string {
  const [year, month, day] = matchDate.split('-').map(Number);
  if (!year || !month || !day) {
    return matchDate;
  }
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  }).format(new Date(year, month - 1, day));
}

function isHistory(record: QueueRecord): boolean {
  return record.status === 'Submitted' || record.status === 'Withdrawn';
}

function matchCard(item: AdminQueueItem): HTMLElement {
  const { record } = item;
  const article = document.createElement('article');
  article.className = 'match-card';

  const top = document.createElement('div');
  top.className = 'match-topline';
  const metadata = document.createElement('div');
  metadata.className = 'metadata';
  metadata.append(
    textElement('span', statusClass(record.status), record.status),
    textElement('span', 'date', formatMatchDate(record.matchDate))
  );
  top.append(metadata, textElement('span', 'match-type', record.matchType === 'D' ? 'Doubles' : 'Singles'));

  const matchup = document.createElement('div');
  matchup.className = 'matchup';
  matchup.append(
    textElement('div', 'team', teamName(record, 1)),
    textElement('div', 'versus', 'vs'),
    textElement('div', 'team', teamName(record, 2))
  );

  const details = document.createElement('dl');
  details.className = 'details';
  const handicapLabel = record.handicapOriginal
    ? record.handicapEntryType === 'difference'
      ? 'Difference'
      : 'Odds'
    : 'Handicap';
  details.append(
    textElement('dt', '', 'Score'),
    textElement('dd', '', record.scoreOriginal),
    textElement('dt', '', handicapLabel),
    textElement('dd', '', record.handicapOriginal || 'Level')
  );
  details.append(textElement('dt', '', 'Type'), textElement('dd', '', record.tournament ? 'Tournament' : 'Friendly'));
  if (record.rtoMatchId) {
    details.append(textElement('dt', '', 'RTO match'), textElement('dd', '', record.rtoMatchId));
  }
  if (record.lastError) {
    details.append(textElement('dt', 'error-label', 'Error'), textElement('dd', 'error-copy', record.lastError));
  }

  article.append(top, matchup, details);
  if (!isHistory(record)) {
    const footer = document.createElement('div');
    footer.className = 'card-footer';
    const action = document.createElement('button');
    action.className = 'card-action';
    action.type = 'button';
    action.textContent = 'Review';
    action.addEventListener('click', () => void openReview(item));
    footer.append(action);
    article.append(footer);
  }
  return article;
}

function visibleItems(): AdminQueueItem[] {
  return allItems.filter(item => (activeView === 'history' ? isHistory(item.record) : !isHistory(item.record)));
}

function emptyMessage(): string {
  return activeView === 'history' ? 'No submission history yet.' : 'No scores need review.';
}

function render(): void {
  const items = visibleItems();
  queueList.replaceChildren(...items.map(matchCard));
  queueMessage.textContent = items.length === 0 ? emptyMessage() : '';
  queueMessage.hidden = items.length > 0;
  reviewTab.setAttribute('aria-selected', String(activeView === 'review'));
  historyTab.setAttribute('aria-selected', String(activeView === 'history'));
}

async function loadQueue(): Promise<void> {
  refreshButton.disabled = true;
  queueMessage.hidden = false;
  queueMessage.textContent = 'Loading queue…';
  try {
    const response = await fetch('/api/queue', { cache: 'no-store' });
    const body = (await response.json()) as { readonly items?: AdminQueueItem[]; readonly message?: string };
    if (!response.ok || !body.items) {
      throw new Error(body.message || 'The queue could not be loaded.');
    }
    allItems = body.items;
    render();
  } catch (error) {
    queueList.replaceChildren();
    queueMessage.textContent = error instanceof Error ? error.message : 'The queue could not be loaded.';
    queueMessage.hidden = false;
  } finally {
    refreshButton.disabled = false;
  }
}

function cachedDirectory(): DirectoryPlayer[] | undefined {
  const serialized = sessionStorage.getItem(DIRECTORY_CACHE_KEY);
  if (!serialized) {
    return undefined;
  }
  try {
    return JSON.parse(serialized) as DirectoryPlayer[];
  } catch {
    sessionStorage.removeItem(DIRECTORY_CACHE_KEY);
    return undefined;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, milliseconds));
}

async function loadDirectory(): Promise<DirectoryPlayer[]> {
  const cached = cachedDirectory();
  if (cached) {
    return cached;
  }
  const [response] = await Promise.all([fetch('/api/directory', { cache: 'no-store' }), delay(900)]);
  const body = (await response.json()) as { readonly players?: DirectoryPlayer[]; readonly message?: string };
  if (!response.ok || !body.players) {
    throw new Error(body.message || 'The player directory could not be loaded.');
  }
  sessionStorage.setItem(DIRECTORY_CACHE_KEY, JSON.stringify(body.players));
  return body.players;
}

function normalizedName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchScore(input: string, candidate: string): number {
  const normalizedInput = normalizedName(input);
  const normalizedCandidate = normalizedName(candidate);
  if (normalizedInput === normalizedCandidate) {
    return 0;
  }
  const inputParts = normalizedInput.split(' ');
  const candidateParts = normalizedCandidate.split(' ');
  const initialMatches = inputParts[0]?.length === 1 && inputParts[0] === candidateParts[0]?.[0];
  const lastNameMatches = inputParts.slice(1).join(' ') === candidateParts.slice(1).join(' ');
  if (initialMatches && lastNameMatches) {
    return 1;
  }
  if (normalizedCandidate.includes(normalizedInput) || normalizedInput.includes(normalizedCandidate)) {
    return 2;
  }
  return 3;
}

function playerMatchField(originalName: string, directory: readonly DirectoryPlayer[]): HTMLElement {
  const label = document.createElement('label');
  label.className = 'player-match';
  label.append(textElement('span', '', originalName));
  const select = document.createElement('select');
  const ordered = [...directory].sort((left, right) => {
    const scoreDifference = matchScore(originalName, left.name) - matchScore(originalName, right.name);
    return scoreDifference || left.name.localeCompare(right.name);
  });
  for (const player of ordered) {
    const option = document.createElement('option');
    option.value = player.id;
    option.textContent = `${player.name} (${player.handicap.toFixed(1)})`;
    select.append(option);
  }
  label.append(select);
  return label;
}

async function openReview(item: AdminQueueItem): Promise<void> {
  selectedItem = item;
  dialogContent.hidden = true;
  dialogActions.hidden = true;
  dialogError.hidden = true;
  dialogLoading.hidden = false;
  loadingLabel.textContent = 'Loading player directory…';
  reviewDialog.showModal();
  try {
    const directory = await loadDirectory();
    const { record } = item;
    dialogMatch.textContent = `${teamName(record, 1)} vs ${teamName(record, 2)} · ${record.scoreOriginal}`;
    playerMatches.replaceChildren(...playerNames(record).map(name => playerMatchField(name, directory)));
    dialogLoading.hidden = true;
    dialogContent.hidden = false;
    dialogActions.hidden = false;
  } catch (error) {
    dialogLoading.hidden = true;
    dialogError.textContent = error instanceof Error ? error.message : 'The directory could not be loaded.';
    dialogError.hidden = false;
  }
}

function closeReview(): void {
  if (!demoSubmitButton.disabled) {
    reviewDialog.close();
    selectedItem = undefined;
  }
}

async function demoSubmit(): Promise<void> {
  if (!selectedItem) {
    return;
  }
  const playerIds = Array.from(playerMatches.querySelectorAll<HTMLSelectElement>('select'), select => select.value);
  demoSubmitButton.disabled = true;
  cancelDialogButton.disabled = true;
  closeDialogButton.disabled = true;
  dialogError.hidden = true;
  try {
    const response = await fetch('/api/submissions/demo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ submissionId: selectedItem.record.submissionId, playerIds })
    });
    const body = (await response.json()) as { readonly submitted?: boolean; readonly message?: string };
    if (!response.ok || !body.submitted) {
      throw new Error(body.message || 'The demo submission failed.');
    }
    reviewDialog.close();
    selectedItem = undefined;
    await loadQueue();
  } catch (error) {
    dialogError.textContent = error instanceof Error ? error.message : 'The demo submission failed.';
    dialogError.hidden = false;
  } finally {
    demoSubmitButton.disabled = false;
    cancelDialogButton.disabled = false;
    closeDialogButton.disabled = false;
  }
}

refreshButton.addEventListener('click', () => void loadQueue());
reviewTab.addEventListener('click', () => {
  activeView = 'review';
  render();
});
historyTab.addEventListener('click', () => {
  activeView = 'history';
  render();
});
closeDialogButton.addEventListener('click', closeReview);
cancelDialogButton.addEventListener('click', closeReview);
demoSubmitButton.addEventListener('click', () => void demoSubmit());
reviewDialog.addEventListener('cancel', event => {
  if (demoSubmitButton.disabled) {
    event.preventDefault();
  }
});
void loadQueue();
