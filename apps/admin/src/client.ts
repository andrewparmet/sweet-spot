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

const DIRECTORY_CACHE_PREFIX = 'sweet-spot-rto-directory-v1';
const SESSION_TOKEN_KEY = 'sweet-spot-rto-token';
const loginShell = requiredElement<HTMLElement>('login-shell');
const adminShell = requiredElement<HTMLElement>('admin-shell');
const loginForm = requiredElement<HTMLFormElement>('login-form');
const identifierInput = requiredElement<HTMLInputElement>('identifier');
const passwordInput = requiredElement<HTMLInputElement>('password');
const loginButton = requiredElement<HTMLButtonElement>('login-button');
const loginError = requiredElement<HTMLElement>('login-error');
const logoutButton = requiredElement<HTMLButtonElement>('logout-button');
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

interface GoogleScriptRunner {
  withSuccessHandler(handler: (response: unknown) => void): GoogleScriptRunner;
  withFailureHandler(handler: (error: { readonly message?: string }) => void): GoogleScriptRunner;
  [functionName: string]: unknown;
}

interface GoogleScriptHost {
  readonly script?: {
    readonly run?: GoogleScriptRunner;
  };
}

function scriptRunner(): GoogleScriptRunner | undefined {
  return (globalThis as typeof globalThis & { readonly google?: GoogleScriptHost }).google?.script?.run;
}

function callServer<T>(functionName: string, ...args: unknown[]): Promise<T> {
  const runner = scriptRunner();
  if (!runner) {
    return callLocalServer<T>(functionName, args);
  }
  return new Promise((resolve, reject) => {
    const configured = runner
      .withSuccessHandler(response => resolve(response as T))
      .withFailureHandler(error => reject(new Error(error.message || 'The request failed.')));
    const serverFunction = configured[functionName];
    if (typeof serverFunction !== 'function') {
      reject(new Error(`Missing server function: ${functionName}`));
      return;
    }
    serverFunction.apply(configured, args);
  });
}

async function callLocalServer<T>(functionName: string, args: readonly unknown[]): Promise<T> {
  const token = sessionStorage.getItem(SESSION_TOKEN_KEY) || '';
  const routes: Record<string, { readonly method: string; readonly path: string }> = {
    adminLogin: { method: 'POST', path: '/api/login' },
    loadAdminQueue: { method: 'GET', path: '/api/queue' },
    loadPlayerDirectory: { method: 'GET', path: '/api/directory' },
    demoSubmitMatch: { method: 'POST', path: '/api/submissions/demo' }
  };
  const route = routes[functionName];
  if (!route) {
    throw new Error(`Missing local route: ${functionName}`);
  }
  const response = await fetch(route.path, {
    method: route.method,
    headers: {
      ...(route.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...(route.method === 'POST' ? { body: JSON.stringify(args.at(-1)) } : {}),
    cache: 'no-store'
  });
  const body = (await response.json()) as T & { readonly message?: string };
  if (!response.ok) {
    throw new Error(body.message || 'The request failed.');
  }
  return body;
}

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
    const token = sessionStorage.getItem(SESSION_TOKEN_KEY);
    if (!token) {
      showLogin();
      return;
    }
    const body = await callServer<{ readonly items?: AdminQueueItem[]; readonly message?: string }>(
      'loadAdminQueue',
      token
    );
    if (!body.items) {
      throw new Error(body.message || 'The queue could not be loaded.');
    }
    allItems = body.items;
    render();
  } catch (error) {
    if (isAuthenticationError(error)) {
      signOut();
      loginError.textContent = error instanceof Error ? error.message : 'Sign in again.';
      loginError.hidden = false;
      return;
    }
    queueList.replaceChildren();
    queueMessage.textContent = error instanceof Error ? error.message : 'The queue could not be loaded.';
    queueMessage.hidden = false;
  } finally {
    refreshButton.disabled = false;
  }
}

function directoryCacheKey(record: QueueRecord): string {
  return `${DIRECTORY_CACHE_PREFIX}:${record.matchType}:${playerNames(record).map(normalizedName).join('|')}`;
}

function cachedDirectory(record: QueueRecord): DirectoryPlayer[] | undefined {
  const serialized = sessionStorage.getItem(directoryCacheKey(record));
  if (!serialized) {
    return undefined;
  }
  try {
    return JSON.parse(serialized) as DirectoryPlayer[];
  } catch {
    sessionStorage.removeItem(directoryCacheKey(record));
    return undefined;
  }
}

async function loadDirectory(record: QueueRecord): Promise<DirectoryPlayer[]> {
  const cached = cachedDirectory(record);
  if (cached) {
    return cached;
  }
  const token = sessionStorage.getItem(SESSION_TOKEN_KEY);
  if (!token) {
    throw new Error('Sign in again.');
  }
  const body = await callServer<{ readonly players?: DirectoryPlayer[]; readonly message?: string }>(
    'loadPlayerDirectory',
    token,
    record.matchType,
    playerNames(record)
  );
  if (!body.players) {
    throw new Error(body.message || 'The player directory could not be loaded.');
  }
  sessionStorage.setItem(directoryCacheKey(record), JSON.stringify(body.players));
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
    const { record } = item;
    const directory = await loadDirectory(record);
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
    const token = sessionStorage.getItem(SESSION_TOKEN_KEY);
    if (!token) {
      throw new Error('Sign in again.');
    }
    const body = await callServer<{ readonly submitted?: boolean; readonly message?: string }>(
      'demoSubmitMatch',
      token,
      { submissionId: selectedItem.record.submissionId, playerIds }
    );
    if (!body.submitted) {
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

function isAuthenticationError(error: unknown): boolean {
  return error instanceof Error && /sign in|administrator|session|authentication/i.test(error.message);
}

function showLogin(): void {
  adminShell.hidden = true;
  loginShell.hidden = false;
}

function showAdmin(): void {
  loginShell.hidden = true;
  adminShell.hidden = false;
}

function signOut(): void {
  sessionStorage.removeItem(SESSION_TOKEN_KEY);
  for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
    const key = sessionStorage.key(index);
    if (key?.startsWith(DIRECTORY_CACHE_PREFIX)) {
      sessionStorage.removeItem(key);
    }
  }
  passwordInput.value = '';
  allItems = [];
  queueList.replaceChildren();
  showLogin();
}

async function login(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  loginError.hidden = true;
  const identifier = identifierInput.value.trim();
  const password = passwordInput.value;
  if (!identifier || !password) {
    loginError.textContent = 'Enter your RTO number or email and password.';
    loginError.hidden = false;
    return;
  }
  loginButton.disabled = true;
  loginButton.textContent = 'Signing in…';
  try {
    const response = await callServer<{ readonly token?: string }>('adminLogin', { identifier, password });
    if (!response.token) {
      throw new Error('RTO sign-in did not return a session.');
    }
    sessionStorage.setItem(SESSION_TOKEN_KEY, response.token);
    passwordInput.value = '';
    showAdmin();
    await loadQueue();
  } catch (error) {
    loginError.textContent = error instanceof Error ? error.message : 'Sign-in failed.';
    loginError.hidden = false;
  } finally {
    loginButton.disabled = false;
    loginButton.textContent = 'Sign in';
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
loginForm.addEventListener('submit', event => void login(event));
logoutButton.addEventListener('click', signOut);
reviewDialog.addEventListener('cancel', event => {
  if (demoSubmitButton.disabled) {
    event.preventDefault();
  }
});
if (sessionStorage.getItem(SESSION_TOKEN_KEY)) {
  showAdmin();
  void loadQueue();
} else {
  showLogin();
}
