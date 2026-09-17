import type { QueueRecord } from '../../../packages/shared/src/queue.ts';
import { isValidScore } from '../../../packages/shared/src/match.ts';
import { normalizedPlayerName, reasonablePlayerMatches } from './player-search.ts';

interface AdminQueueItem {
  readonly tabName: string;
  readonly record: QueueRecord;
}

interface DirectoryPlayer {
  readonly id: string;
  readonly name: string;
  readonly handicap: number;
  readonly isBoston: boolean;
}

type QueueView = 'review' | 'history';

const DIRECTORY_CACHE_PREFIX = 'sweet-spot-rto-directory-v7';
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
const reviewScore = requiredElement<HTMLInputElement>('review-score');
const playerMatches = requiredElement<HTMLElement>('player-matches');
const dialogError = requiredElement<HTMLElement>('dialog-error');
const dialogActions = requiredElement<HTMLElement>('dialog-actions');

let allItems: AdminQueueItem[] = [];
let activeView: QueueView = 'review';
let selectedItem: AdminQueueItem | undefined;
let submitting = false;
const directoryLoads = new Map<QueueRecord['matchType'], Promise<DirectoryPlayer[]>>();

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
    loadBostonDirectory: { method: 'GET', path: '/api/boston-directory' },
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
  const body = (await response.json()) as T & { readonly message?: string; readonly players?: DirectoryPlayer[] };
  if (!response.ok) {
    throw new Error(body.message || 'The request failed.');
  }
  if (functionName === 'loadPlayerDirectory' && body.players && Array.isArray(args[2])) {
    return {
      results: (args[2] as unknown[]).map(query => ({ query: String(query), players: body.players }))
    } as T;
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

function bostonDirectoryCacheKey(matchType: QueueRecord['matchType']): string {
  return `${DIRECTORY_CACHE_PREFIX}:boston:${matchType}`;
}

function expandedDirectoryCacheKey(matchType: QueueRecord['matchType'], playerName: string): string {
  return `${DIRECTORY_CACHE_PREFIX}:expanded:${matchType}:${normalizedPlayerName(playerName)}`;
}

function cachedPlayers(key: string): DirectoryPlayer[] | undefined {
  const serialized = sessionStorage.getItem(key);
  if (!serialized) {
    return undefined;
  }
  try {
    return JSON.parse(serialized) as DirectoryPlayer[];
  } catch {
    sessionStorage.removeItem(key);
    return undefined;
  }
}

async function loadBostonPlayers(matchType: QueueRecord['matchType']): Promise<DirectoryPlayer[]> {
  const cacheKey = bostonDirectoryCacheKey(matchType);
  const cached = cachedPlayers(cacheKey);
  if (cached) {
    return cached;
  }
  const existingLoad = directoryLoads.get(matchType);
  if (existingLoad) {
    return existingLoad;
  }
  const token = sessionStorage.getItem(SESSION_TOKEN_KEY);
  if (!token) {
    throw new Error('Sign in again.');
  }
  const load = (async () => {
    const body = await callServer<{
      readonly players?: DirectoryPlayer[];
      readonly message?: string;
    }>('loadBostonDirectory', token, matchType);
    if (!body.players) {
      throw new Error(body.message || 'The Boston player directory could not be loaded.');
    }
    sessionStorage.setItem(cacheKey, JSON.stringify(body.players));
    return body.players;
  })();
  directoryLoads.set(matchType, load);
  try {
    return await load;
  } finally {
    directoryLoads.delete(matchType);
  }
}

async function expandPlayerSearch(matchType: QueueRecord['matchType'], playerName: string): Promise<DirectoryPlayer[]> {
  const cacheKey = expandedDirectoryCacheKey(matchType, playerName);
  const cached = cachedPlayers(cacheKey);
  if (cached) {
    return cached;
  }
  const token = sessionStorage.getItem(SESSION_TOKEN_KEY);
  if (!token) {
    throw new Error('Sign in again.');
  }
  const body = await callServer<{
    readonly results?: { readonly query: string; readonly players: DirectoryPlayer[] }[];
    readonly message?: string;
  }>('loadPlayerDirectory', token, matchType, [playerName]);
  const players = body.results?.[0]?.players;
  if (!players) {
    throw new Error(body.message || 'The wider player directory could not be searched.');
  }
  sessionStorage.setItem(cacheKey, JSON.stringify(players));
  return players;
}

function mergePlayers(...directories: readonly DirectoryPlayer[][]): DirectoryPlayer[] {
  const playersById = new Map<string, DirectoryPlayer>();
  for (const directory of directories) {
    for (const player of directory) {
      playersById.set(player.id, player);
    }
  }
  return [...playersById.values()];
}

function renderPlayerOptions(
  select: HTMLSelectElement,
  originalName: string,
  directory: readonly DirectoryPlayer[]
): void {
  select.replaceChildren();
  const ordered = reasonablePlayerMatches(originalName, directory);
  const bestMatchId = ordered[0]?.id;
  if (!bestMatchId) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No Boston match. Expand or search manually.';
    option.selected = true;
    option.disabled = true;
    select.append(option);
    return;
  }
  for (const [groupLabel, players] of [
    ['Boston players', ordered.filter(player => player.isBoston)],
    ['Other players', ordered.filter(player => !player.isBoston)]
  ] as const) {
    if (players.length === 0) {
      continue;
    }
    const group = document.createElement('optgroup');
    group.label = groupLabel;
    for (const player of players) {
      const option = document.createElement('option');
      option.value = player.id;
      option.textContent = `${player.name} (${player.handicap.toFixed(1)})`;
      option.selected = player.id === bestMatchId;
      group.append(option);
    }
    select.append(group);
  }
}

function updateSubmitAvailability(): void {
  const selects = [...playerMatches.querySelectorAll<HTMLSelectElement>('select')];
  demoSubmitButton.disabled =
    submitting || !isValidScore(reviewScore.value) || selects.length === 0 || selects.some(select => !select.value);
}

function playerMatchField(
  originalName: string,
  matchType: QueueRecord['matchType'],
  bostonPlayers: readonly DirectoryPlayer[],
  index: number
): HTMLElement {
  const field = document.createElement('div');
  field.className = 'player-match';
  const heading = document.createElement('div');
  heading.className = 'player-match-heading';
  const label = document.createElement('label');
  const selectId = `player-match-${index}`;
  label.htmlFor = selectId;
  label.textContent = originalName;
  const searchActions = document.createElement('div');
  searchActions.className = 'player-search-actions';
  const expandButton = document.createElement('button');
  expandButton.className = 'expand-search';
  expandButton.type = 'button';
  expandButton.textContent = 'Expand search';
  const manualButton = document.createElement('button');
  manualButton.className = 'expand-search';
  manualButton.type = 'button';
  manualButton.textContent = 'Manual search';
  manualButton.setAttribute('aria-expanded', 'false');
  searchActions.append(expandButton, manualButton);
  heading.append(label, searchActions);
  const select = document.createElement('select');
  select.id = selectId;
  renderPlayerOptions(select, originalName, bostonPlayers);
  const manualSearch = document.createElement('form');
  manualSearch.className = 'manual-search';
  manualSearch.hidden = true;
  const manualInput = document.createElement('input');
  manualInput.type = 'search';
  manualInput.value = originalName;
  manualInput.autocomplete = 'off';
  manualInput.setAttribute('aria-label', `Search RTO directory for ${originalName}`);
  const searchButton = document.createElement('button');
  searchButton.className = 'secondary-button';
  searchButton.type = 'submit';
  searchButton.textContent = 'Search';
  manualSearch.append(manualInput, searchButton);
  let fieldPlayers = [...bostonPlayers];
  const addExpandedPlayers = async (query: string): Promise<void> => {
    const expandedPlayers = await expandPlayerSearch(matchType, query);
    fieldPlayers = mergePlayers(expandedPlayers, fieldPlayers);
    renderPlayerOptions(select, query, fieldPlayers);
    updateSubmitAvailability();
  };
  expandButton.addEventListener('click', async () => {
    expandButton.disabled = true;
    expandButton.textContent = 'Searching…';
    dialogError.hidden = true;
    try {
      await addExpandedPlayers(originalName);
      expandButton.textContent = 'Expanded';
    } catch (error) {
      expandButton.disabled = false;
      expandButton.textContent = 'Expand search';
      dialogError.textContent = error instanceof Error ? error.message : 'The wider directory could not be searched.';
      dialogError.hidden = false;
    }
  });
  manualButton.addEventListener('click', () => {
    manualSearch.hidden = !manualSearch.hidden;
    manualButton.setAttribute('aria-expanded', String(!manualSearch.hidden));
    if (!manualSearch.hidden) {
      manualInput.focus();
      manualInput.select();
    }
  });
  manualSearch.addEventListener('submit', async event => {
    event.preventDefault();
    const query = manualInput.value.trim();
    if (!query) {
      dialogError.textContent = 'Enter a player name to search.';
      dialogError.hidden = false;
      manualInput.focus();
      return;
    }
    manualInput.disabled = true;
    searchButton.disabled = true;
    searchButton.textContent = 'Searching…';
    dialogError.hidden = true;
    try {
      await addExpandedPlayers(query);
    } catch (error) {
      dialogError.textContent = error instanceof Error ? error.message : 'The wider directory could not be searched.';
      dialogError.hidden = false;
    } finally {
      manualInput.disabled = false;
      searchButton.disabled = false;
      searchButton.textContent = 'Search';
    }
  });
  field.append(heading, select, manualSearch);
  return field;
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
    const names = playerNames(record);
    const bostonPlayers = await loadBostonPlayers(record.matchType);
    dialogMatch.textContent = `${teamName(record, 1)} vs ${teamName(record, 2)}`;
    reviewScore.value = record.scoreOriginal;
    playerMatches.replaceChildren(
      ...names.map((name, index) => playerMatchField(name, record.matchType, bostonPlayers, index))
    );
    updateSubmitAvailability();
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
  if (!submitting) {
    reviewDialog.close();
    selectedItem = undefined;
  }
}

async function demoSubmit(): Promise<void> {
  if (!selectedItem) {
    return;
  }
  const playerIds = Array.from(playerMatches.querySelectorAll<HTMLSelectElement>('select'), select => select.value);
  if (playerIds.some(playerId => !playerId)) {
    dialogError.textContent = 'Match every entered player before submitting.';
    dialogError.hidden = false;
    return;
  }
  const score = reviewScore.value.trim();
  if (!isValidScore(score)) {
    dialogError.textContent = 'Enter game scores like 6-2,6-1 or 10-8.';
    dialogError.hidden = false;
    reviewScore.focus();
    return;
  }
  submitting = true;
  demoSubmitButton.textContent = 'Submitting…';
  updateSubmitAvailability();
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
      { submissionId: selectedItem.record.submissionId, playerIds, score }
    );
    if (!body.submitted) {
      throw new Error(body.message || 'The submission failed.');
    }
    reviewDialog.close();
    selectedItem = undefined;
    await loadQueue();
  } catch (error) {
    dialogError.textContent = error instanceof Error ? error.message : 'The submission failed.';
    dialogError.hidden = false;
  } finally {
    submitting = false;
    demoSubmitButton.textContent = 'Submit';
    updateSubmitAvailability();
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
  directoryLoads.clear();
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
    void Promise.allSettled([loadBostonPlayers('S'), loadBostonPlayers('D')]);
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
reviewScore.addEventListener('input', updateSubmitAvailability);
loginForm.addEventListener('submit', event => void login(event));
logoutButton.addEventListener('click', signOut);
reviewDialog.addEventListener('cancel', event => {
  if (submitting) {
    event.preventDefault();
  }
});
if (sessionStorage.getItem(SESSION_TOKEN_KEY)) {
  showAdmin();
  void Promise.allSettled([loadBostonPlayers('S'), loadBostonPlayers('D')]);
  void loadQueue();
} else {
  showLogin();
}
