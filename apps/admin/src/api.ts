import type { HandicapEntryType, MatchType } from '../../../packages/shared/src/match.ts';
import type { QueueRecord } from '../../../packages/shared/src/queue.ts';

export interface AdminQueueItem {
  readonly tabName: string;
  readonly record: QueueRecord;
}

export interface DirectoryPlayer {
  readonly id: string;
  readonly name: string;
  readonly handicap: number;
  readonly isBoston: boolean;
}

export interface SanctionedMatch {
  readonly id: string;
  readonly description: string;
}

export interface ReviewedPlayer {
  readonly id: string;
  readonly handicap: number;
}

export type QueueView = 'review' | 'history';

export interface QueueRequest {
  readonly view: QueueView;
  readonly page: number;
}

export interface QueuePage {
  readonly items: AdminQueueItem[];
  readonly page: number;
  readonly hasNext: boolean;
  readonly week: string;
}

export interface ReviewedMatchRequest {
  readonly submissionId: string;
  readonly tabName: string;
  readonly players: readonly ReviewedPlayer[];
  readonly score: string;
  readonly handicap: string;
  readonly sanctionedMatch: string;
}

export interface AdminEntryRequest {
  readonly requestId: string;
  readonly matchType: MatchType;
  readonly matchDate: string;
  readonly side1Player1: string;
  readonly side1Player2: string;
  readonly side2Player1: string;
  readonly side2Player2: string;
  readonly score: string;
  readonly handicapType: HandicapEntryType;
  readonly handicap: string;
  readonly tournament: boolean;
  readonly sanctioned: boolean;
}

const SESSION_TOKEN_KEY = 'sweet-spot-rto-token';

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

export function sessionToken(): string | null {
  return sessionStorage.getItem(SESSION_TOKEN_KEY);
}

export function saveSessionToken(token: string): void {
  sessionStorage.setItem(SESSION_TOKEN_KEY, token);
}

export function clearSessionToken(): void {
  sessionStorage.removeItem(SESSION_TOKEN_KEY);
}

export function isAuthenticationError(error: unknown): boolean {
  return error instanceof Error && /sign[- ]?in|administrator|session|authentication/i.test(error.message);
}

export async function adminLogin(identifier: string, password: string): Promise<string> {
  const response = await callServer<{ readonly token?: string }>('adminLogin', {
    identifier,
    password,
    clientContext: {
      userAgent: navigator.userAgent,
      language: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
    }
  });
  if (!response.token) {
    throw new Error('RTO sign-in did not return a session.');
  }
  return response.token;
}

export async function loadAdminQueue(request: QueueRequest): Promise<QueuePage> {
  const body = await callServer<{
    readonly items?: AdminQueueItem[];
    readonly page?: number;
    readonly hasNext?: boolean;
    readonly week?: string;
    readonly message?: string;
  }>('loadAdminQueue', requiredToken(), request);
  if (!body.items) {
    throw new Error(body.message || 'The queue could not be loaded.');
  }
  return { items: body.items, page: body.page ?? request.page, hasNext: body.hasNext === true, week: body.week ?? '' };
}

export async function loadBostonDirectory(matchType: MatchType): Promise<DirectoryPlayer[]> {
  const body = await callServer<{
    readonly players?: DirectoryPlayer[];
    readonly message?: string;
  }>('loadBostonDirectory', requiredToken(), matchType);
  if (!body.players) {
    throw new Error(body.message || 'The Boston player directory could not be loaded.');
  }
  return body.players;
}

export async function loadPlayerDirectory(matchType: MatchType, playerName: string): Promise<DirectoryPlayer[]> {
  const body = await callServer<{
    readonly results?: { readonly query: string; readonly players: DirectoryPlayer[] }[];
    readonly message?: string;
  }>('loadPlayerDirectory', requiredToken(), matchType, [playerName]);
  const players = body.results?.[0]?.players;
  if (!players) {
    throw new Error(body.message || 'The wider player directory could not be searched.');
  }
  return players;
}

export async function loadSanctionedMatches(): Promise<SanctionedMatch[]> {
  const body = await callServer<{
    readonly matches?: SanctionedMatch[];
    readonly message?: string;
  }>('loadSanctionedMatches', requiredToken());
  if (!body.matches) {
    throw new Error(body.message || 'The sanctioned match list could not be loaded.');
  }
  return body.matches;
}

export async function submitReviewedMatch(request: ReviewedMatchRequest): Promise<void> {
  const body = await callServer<{ readonly submitted?: boolean; readonly message?: string }>(
    'submitReviewedMatch',
    requiredToken(),
    request
  );
  if (!body.submitted) {
    throw new Error(body.message || 'The submission failed.');
  }
}

export async function submitAdminEntry(request: AdminEntryRequest): Promise<void> {
  const body = await callServer<{ readonly submissionId?: string; readonly message?: string }>(
    'submitAdminEntry',
    requiredToken(),
    request
  );
  if (!body.submissionId) {
    throw new Error(body.message || 'The score could not be added.');
  }
}

export function bostonToday(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'America/New_York',
    year: 'numeric'
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find(value => value.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export async function deleteQueuedMatch(item: AdminQueueItem): Promise<void> {
  const body = await callServer<{ readonly deleted?: boolean; readonly message?: string }>(
    'deleteQueuedMatch',
    requiredToken(),
    { submissionId: item.record.submissionId, tabName: item.tabName }
  );
  if (!body.deleted) {
    throw new Error(body.message || 'The submission could not be deleted.');
  }
}

function requiredToken(): string {
  const token = sessionToken();
  if (!token) {
    throw new Error('Sign in again.');
  }
  return token;
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
  const token = sessionToken() || '';
  const routes: Record<string, { readonly method: string; readonly path: string }> = {
    adminLogin: { method: 'POST', path: '/api/login' },
    loadAdminQueue: { method: 'GET', path: '/api/queue' },
    loadBostonDirectory: { method: 'GET', path: '/api/boston-directory' },
    loadPlayerDirectory: { method: 'GET', path: '/api/directory' },
    loadSanctionedMatches: { method: 'GET', path: '/api/sanctioned-matches' },
    submitReviewedMatch: { method: 'POST', path: '/api/submissions/demo' },
    deleteQueuedMatch: { method: 'POST', path: '/api/submissions/delete' },
    submitAdminEntry: { method: 'POST', path: '/api/entries' }
  };
  const route = routes[functionName];
  if (!route) {
    throw new Error(`Missing local route: ${functionName}`);
  }
  const queueRequest = functionName === 'loadAdminQueue' ? args.at(-1) : undefined;
  const queueQuery =
    queueRequest && typeof queueRequest === 'object'
      ? `?view=${encodeURIComponent(String(Reflect.get(queueRequest, 'view')))}&page=${encodeURIComponent(String(Reflect.get(queueRequest, 'page')))}`
      : '';
  const response = await fetch(route.path + queueQuery, {
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
