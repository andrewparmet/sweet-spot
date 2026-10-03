import { QUEUE_HEADERS, queueRecordToRow, type QueueRecord } from '../../../packages/shared/src/queue.ts';
import {
  ensureWeekSheet,
  findSubmissionByRequestId,
  isoWeekTabName,
  newQueueRecord,
  rememberSubmission
} from '../../../packages/shared/src/queue-sheet.ts';
import { requiredText, validateMatchDate, validateMatchFields } from '../../../packages/shared/src/submission.ts';
import { isValidOdds, normalizeScore, scoreError } from '../../../packages/shared/src/match.ts';
import { directorySearchTerms } from './player-search.ts';
import {
  loadQueuePage,
  parseQueueIndex,
  withHistoryTab,
  type QueueIndex,
  type QueuePage,
  type QueueView
} from './queue-index.ts';
import { wasRejectedByRto } from './format.ts';
import { DUPLICATE_MATCH_MESSAGE, resolvePlayedHandicapDifference, type OddsReferenceRow } from './rto-match.ts';

const RTO_API = 'https://www.realtennisonline.com/v2/api';
const BOSTON_ORGANIZATION_ID = 36;
const BOSTON_TIME_ZONE = 'America/New_York';
const WEEK_SHEET_NAME_PATTERN = /^\d{4}-W\d{2}$/;
const LOGIN_RATE_LIMIT = 10;
const TOKEN_VALIDATION_RATE_LIMIT = 120;
const RATE_LIMIT_SECONDS = 60;
const VALIDATED_SESSION_CACHE_SECONDS = 300;
const QUEUE_INDEX_PROPERTY_PREFIX = 'SWEET_SPOT_QUEUE_INDEX:';
const RTO_REFERENCE_CACHE_SECONDS = 21_600;

class RtoMatchSaveError extends Error {
  constructor(
    message: string,
    readonly rejected: boolean,
    readonly status?: number
  ) {
    super(message);
  }
}

interface LoginRequest {
  readonly identifier: string;
  readonly password: string;
}

interface ReviewedPlayer {
  readonly id: number;
  readonly handicap: number;
}

interface ReviewedSubmissionRequest {
  readonly submissionId: string;
  readonly tabName: string;
  readonly players: ReviewedPlayer[];
  readonly score: string;
  readonly handicap: string;
  readonly sanctionedMatch: string;
  readonly duplicateConfirmed: boolean;
}

interface SanctionedMatch {
  readonly id: string;
  readonly description: string;
}

interface RtoRole {
  readonly Role?: string;
  readonly OrgID?: number;
  readonly StartDate?: string;
  readonly EndDate?: string;
}

interface DirectoryPlayer {
  readonly id: string;
  readonly name: string;
  readonly handicap: number;
  readonly isBoston: boolean;
}

interface PlayerSearchResult {
  readonly query: string;
  readonly players: DirectoryPlayer[];
}

interface ResolvedHandicap {
  readonly difference: string;
  readonly type: 'H' | 'L';
}

export function doGet(): GoogleAppsScript.HTML.HtmlOutput {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Score Review')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

export function loadBostonDirectory(token: unknown, matchType: unknown): { readonly players: DirectoryPlayer[] } {
  const sessionToken = requiredString(token, 'RTO session');
  authorize(sessionToken);
  const type = requiredMatchType(matchType);
  const requests = 'abcdefghijklmnopqrstuvwxyz'.split('').map(letter => ({
    url: `${RTO_API}/Person/list/search/court/${BOSTON_ORGANIZATION_ID}?text=${letter}&sd=${type}&initial=true`,
    method: 'get' as const,
    headers: { Authorization: `Bearer ${sessionToken}` },
    muteHttpExceptions: true
  }));
  const playersById = new Map<string, DirectoryPlayer>();
  for (const response of UrlFetchApp.fetchAll(requests)) {
    const candidates = parseRtoResponse(response);
    if (!Array.isArray(candidates)) {
      throw new Error('RTO returned an unreadable Boston player directory.');
    }
    for (const candidate of candidates) {
      const player = directoryPlayer(candidate, new Map(), true);
      if (player) {
        playersById.set(player.id, player);
      }
    }
  }
  return { players: [...playersById.values()].sort((left, right) => left.name.localeCompare(right.name)) };
}

export function loadSanctionedMatches(token: unknown): { readonly matches: SanctionedMatch[] } {
  const sessionToken = requiredString(token, 'RTO session');
  authorize(sessionToken);
  return { matches: sanctionedMatches(sessionToken) };
}

function sanctionedMatches(sessionToken: string): SanctionedMatch[] {
  const cacheKey = 'rto:sanctioned-matches';
  const cached = CacheService.getScriptCache().get(cacheKey);
  if (cached) {
    return JSON.parse(cached) as SanctionedMatch[];
  }
  const matches = fetchSanctionedMatches(sessionToken);
  cacheReference(cacheKey, matches);
  return matches;
}

function fetchSanctionedMatches(sessionToken: string): SanctionedMatch[] {
  const response = rtoGet('/SanctionedMatch/getAll', sessionToken);
  if (!Array.isArray(response)) {
    throw new Error('RTO returned an unreadable sanctioned match list.');
  }
  return response.flatMap(value => {
    if (!isRecord(value) || value.isDeleted === true || value.IsDeleted === true) {
      return [];
    }
    const id = value.sanctionedMatchID ?? value.SanctionedMatchID;
    const description = readString(value, 'description', 'Description').trim();
    return (typeof id === 'string' || typeof id === 'number') && description ? [{ id: String(id), description }] : [];
  });
}

export function adminLogin(payload: unknown): { readonly token: string } {
  const auditContext = loginAuditContext(payload);
  try {
    enforceAdminRateLimit('login', LOGIN_RATE_LIMIT, 'Too many sign-in attempts. Try again in a minute.');
    const request = validateLoginRequest(payload);
    const response = rtoRequest('/User/login', {
      identifier: request.identifier,
      password: request.password
    });
    const token = readString(response, 'token', 'Token');
    if (!token) {
      throw new Error('RTO sign-in did not return a session.');
    }
    const claims = authorize(token);
    auditLog('admin_login', { outcome: 'success', userId: numericUserId(claims), ...auditContext });
    return { token };
  } catch (error) {
    auditLog('admin_login', { outcome: 'failed', ...auditContext, error: safeErrorMessage(error) }, 'warning');
    throw error;
  }
}

export function loadAdminQueue(token: unknown, spreadsheetId: string, request: unknown): QueuePage {
  authorize(requiredString(token, 'RTO session'));
  const { view, page } = validateQueuePageRequest(request);
  const sheets = new Map(
    SpreadsheetApp.openById(spreadsheetId)
      .getSheets()
      .filter(sheet => WEEK_SHEET_NAME_PATTERN.test(sheet.getName()))
      .map(sheet => [sheet.getName(), sheet])
  );
  const result = loadQueuePage(
    { names: [...sheets.keys()], read: tabName => (sheets.has(tabName) ? recordsFromSheet(sheets.get(tabName)!) : []) },
    readQueueIndex(spreadsheetId),
    view,
    page,
    Date.now()
  );
  writeQueueIndex(spreadsheetId, result.index);
  return result.page;
}

export function loadPlayerDirectory(
  token: unknown,
  matchType: unknown,
  playerNames: unknown
): { readonly results: PlayerSearchResult[] } {
  const sessionToken = requiredString(token, 'RTO session');
  authorize(sessionToken);
  const type = requiredMatchType(matchType);
  if (!Array.isArray(playerNames) || playerNames.length < 1 || playerNames.length > 4) {
    throw new Error('The player search is incomplete.');
  }
  const names = playerNames.map(name => requiredString(name, 'Player name'));
  return { results: names.map(name => searchPlayers(sessionToken, type, name)) };
}

function searchPlayers(sessionToken: string, type: 'S' | 'D', name: string): PlayerSearchResult {
  const primaryOrgByPersonId = new Map<number, number>();
  const resolvedNames = new Set<string>();
  for (const directoryQuery of directorySearchTerms(name)) {
    const directoryResponse = rtoGet(
      `/Person/directory/search?query=${encodeURIComponent(directoryQuery)}&maxResults=10`,
      sessionToken
    );
    if (!isRecord(directoryResponse) || !Array.isArray(directoryResponse.people ?? directoryResponse.People)) {
      throw new Error('RTO returned an unreadable person directory.');
    }
    const people = (directoryResponse.people ?? directoryResponse.People) as unknown[];
    for (const person of people.slice(0, 10)) {
      if (!isRecord(person)) {
        continue;
      }
      const personId = Number(person.personID ?? person.PersonID);
      const primaryOrgId = Number(person.primaryOrgID ?? person.PrimaryOrgID);
      const resolvedName = readString(person, 'nameFirstLastTag', 'NameFirstLastTag', 'nameFirstLast', 'NameFirstLast');
      if (Number.isFinite(personId) && Number.isFinite(primaryOrgId)) {
        primaryOrgByPersonId.set(personId, primaryOrgId);
      }
      if (resolvedName) {
        resolvedNames.add(resolvedName);
      }
    }
  }
  const queries = new Set([...directorySearchTerms(name), ...resolvedNames]);
  const playersById = new Map<string, DirectoryPlayer>();
  for (const query of queries) {
    const response = rtoGet(
      `/Person/list/search/SD/${type}?text=${encodeURIComponent(query)}&initial=false&mustHavePrimaryOrg=false`,
      sessionToken
    );
    if (!Array.isArray(response)) {
      throw new Error('RTO returned an unreadable player directory.');
    }
    for (const candidate of response) {
      const player = directoryPlayer(candidate, primaryOrgByPersonId);
      if (player) {
        playersById.set(player.id, player);
      }
    }
  }
  return { query: name, players: [...playersById.values()] };
}

export function submitReviewedMatch(
  token: unknown,
  payload: unknown,
  spreadsheetId: string,
  liveRtoSubmission: boolean
): { readonly submitted: true } {
  const sessionToken = requiredString(token, 'RTO session');
  const claims = authorize(sessionToken);
  const request = validateReviewedSubmission(payload);
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  const lock = LockService.getScriptLock();
  lock.waitLock(10_000);
  try {
    const sheet = spreadsheet.getSheetByName(request.tabName);
    const submissionIds =
      sheet && sheet.getLastRow() >= 2 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getDisplayValues() : [];
    const rowOffset = submissionIds.findIndex(([submissionId]) => submissionId === request.submissionId);
    if (!sheet || rowOffset < 0) {
      throw new Error('That submission could not be found.');
    }
    const rowNumber = rowOffset + 2;
    const queuedRecord = recordFromRow(
      sheet.getRange(rowNumber, 1, 1, QUEUE_HEADERS.length).getDisplayValues()[0] ?? []
    );
    const record = { ...queuedRecord, handicapOriginal: validReviewedHandicap(queuedRecord, request.handicap) };
    const expectedPlayerCount = record.matchType === 'D' ? 4 : 2;
    if (request.players.length !== expectedPlayerCount) {
      throw new Error(`Choose ${expectedPlayerCount} RTO players for this match.`);
    }
    if (record.status === 'Submitted' || record.status === 'Withdrawn') {
      throw new Error('That submission is no longer available for review.');
    }
    if (liveRtoSubmission && record.status === 'Needs reconciliation' && !wasRejectedByRto(record)) {
      throw new Error('This submission may already have reached RTO and must be reconciled before retrying.');
    }
    const description = record.sanctioned ? request.sanctionedMatch : '';
    if (record.sanctioned && !description) {
      throw new Error('Choose the sanctioned match.');
    }
    if (
      liveRtoSubmission &&
      description &&
      !sanctionedMatches(sessionToken).some(match => match.description === description)
    ) {
      throw new Error('That sanctioned match is no longer listed in RTO.');
    }
    const timestamp = Utilities.formatDate(new Date(), BOSTON_TIME_ZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
    const playerIds = request.players.map(player => String(player.id));
    const score = normalizeScore(request.score);
    const reviewed = {
      ...queuedRecord,
      rtoPlayerIds: playerIds.join(','),
      scoreNormalized: score,
      updatedAt: timestamp
    };
    if (!liveRtoSubmission) {
      writeReviewColumns(sheet, rowNumber, { ...reviewed, status: 'Submitted', rtoMatchId: `demo-${Date.now()}` });
      recordHistoryTab(spreadsheetId, request.tabName);
      auditLog('match_submission', {
        environment: 'staging',
        outcome: 'submitted',
        submissionId: request.submissionId,
        userId: numericUserId(claims),
        playerIds
      });
      return { submitted: true };
    }

    let handicap: ResolvedHandicap;
    try {
      handicap = resolveHandicap(sessionToken, record, request.players);
    } catch (error) {
      writeReviewColumns(sheet, rowNumber, {
        ...queuedRecord,
        status: 'Failed',
        lastError: safeErrorMessage(error),
        updatedAt: timestamp
      });
      auditLog(
        'match_submission',
        {
          environment: 'production',
          outcome: 'handicap_failed',
          submissionId: request.submissionId,
          userId: numericUserId(claims),
          playerIds,
          error: safeErrorMessage(error)
        },
        'warning'
      );
      throw error;
    }
    const started: QueueRecord = {
      ...reviewed,
      status: 'Needs reconciliation',
      rtoHandicapDifference: handicap.difference,
      lastError: ''
    };
    writeReviewColumns(sheet, rowNumber, started);
    SpreadsheetApp.flush();
    auditLog('match_submission', {
      environment: 'production',
      outcome: 'started',
      submissionId: request.submissionId,
      userId: numericUserId(claims),
      playerIds
    });

    let matchId: number;
    try {
      matchId = saveRtoMatch(
        sessionToken,
        claims,
        record,
        request.players,
        score,
        handicap,
        description,
        request.duplicateConfirmed
      );
    } catch (error) {
      writeReviewColumns(sheet, rowNumber, {
        ...started,
        status: error instanceof RtoMatchSaveError && error.rejected ? 'Failed' : started.status,
        lastError: safeErrorMessage(error)
      });
      auditLog(
        'match_submission',
        {
          environment: 'production',
          outcome: error instanceof RtoMatchSaveError && error.rejected ? 'rejected' : 'unknown',
          submissionId: request.submissionId,
          userId: numericUserId(claims),
          playerIds,
          httpStatus: error instanceof RtoMatchSaveError ? error.status : undefined,
          error: safeErrorMessage(error)
        },
        'warning'
      );
      throw error;
    }
    writeReviewColumns(sheet, rowNumber, { ...started, status: 'Submitted', rtoMatchId: String(matchId) });
    recordHistoryTab(spreadsheetId, request.tabName);
    auditLog('match_submission', {
      environment: 'production',
      outcome: 'submitted',
      submissionId: request.submissionId,
      userId: numericUserId(claims),
      playerIds,
      matchId
    });
    return { submitted: true };
  } finally {
    lock.releaseLock();
  }
}

export function submitAdminEntry(
  token: unknown,
  payload: unknown,
  spreadsheetId: string
): { readonly submissionId: string } {
  const claims = authorize(requiredString(token, 'RTO session'));
  if (!isRecord(payload)) {
    throw new Error('The match entry is missing.');
  }
  const now = new Date();
  const today = Utilities.formatDate(now, BOSTON_TIME_ZONE, 'yyyy-MM-dd');
  const requestId = requiredText(payload.requestId, 'Request ID', 64);
  const fields = validateMatchFields(payload);
  const matchDate = validateMatchDate(payload.matchDate, today);
  const sanctioned = payload.sanctioned === true;
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  const lock = LockService.getScriptLock();
  lock.waitLock(10_000);
  try {
    const existingSubmissionId = findSubmissionByRequestId(spreadsheet, requestId, today);
    if (existingSubmissionId) {
      return { submissionId: existingSubmissionId };
    }
    const submissionId = Utilities.getUuid();
    const timestamp = Utilities.formatDate(now, BOSTON_TIME_ZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
    const sheet = ensureWeekSheet(spreadsheet, isoWeekTabName(today));
    sheet.appendRow(
      queueRecordToRow(newQueueRecord(fields, { submissionId, requestId, timestamp, matchDate, sanctioned }))
    );
    rememberSubmission(requestId, submissionId);
    auditLog('admin_entry', { submissionId, sanctioned, userId: numericUserId(claims) });
    return { submissionId };
  } finally {
    lock.releaseLock();
  }
}

export function deleteQueuedMatch(token: unknown, payload: unknown, spreadsheetId: string): { readonly deleted: true } {
  const claims = authorize(requiredString(token, 'RTO session'));
  const request = validateQueuedMatchReference(payload);
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  const lock = LockService.getScriptLock();
  lock.waitLock(10_000);
  try {
    const sheet = spreadsheet.getSheetByName(request.tabName);
    const submissionIds =
      sheet && sheet.getLastRow() >= 2 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getDisplayValues() : [];
    const rowOffset = submissionIds.findIndex(([submissionId]) => submissionId === request.submissionId);
    if (!sheet || rowOffset < 0) {
      throw new Error('That submission could not be found.');
    }
    const rowNumber = rowOffset + 2;
    const record = recordFromRow(sheet.getRange(rowNumber, 1, 1, QUEUE_HEADERS.length).getDisplayValues()[0] ?? []);
    if (record.status === 'Submitted' || (record.status === 'Needs reconciliation' && !wasRejectedByRto(record))) {
      throw new Error('That score may already be in RTO and cannot be deleted here.');
    }
    sheet.deleteRow(rowNumber);
    auditLog('queue_deletion', {
      submissionId: request.submissionId,
      status: record.status,
      userId: numericUserId(claims)
    });
    return { deleted: true };
  } finally {
    lock.releaseLock();
  }
}

function resolveHandicap(token: string, record: QueueRecord, players: readonly ReviewedPlayer[]): ResolvedHandicap {
  const enteredHandicap = record.handicapOriginal.trim();
  if (!enteredHandicap || enteredHandicap.replace(/\s+/g, '') === '0/0') {
    return { difference: '', type: 'L' };
  }
  if (record.handicapEntryType === 'difference') {
    const difference = Number(enteredHandicap);
    if (!Number.isFinite(difference)) {
      throw new Error('The handicap difference is invalid.');
    }
    return { difference: String(difference), type: 'H' };
  }

  const cache = CacheService.getScriptCache();
  const oddsCacheKey = `rto:odds:${record.matchType}:${record.matchDate}`;
  const cachedOdds = cache.get(oddsCacheKey);
  const [calculatorResponse, oddsResponse] = UrlFetchApp.fetchAll([
    rtoPostRequest('/Utility/odds/calculator', oddsCalculatorPayload(record, players), token),
    ...(cachedOdds
      ? []
      : [
          rtoGetRequest(
            `/Utility/odds/getAll/${record.matchType}?effectiveDate=${encodeURIComponent(record.matchDate)}`,
            token
          )
        ])
  ]);
  const calculator = calculatorResponse ? parseRtoResponse(calculatorResponse) : undefined;
  if (!isRecord(calculator)) {
    throw new Error('RTO returned an unreadable handicap calculation.');
  }
  const suggestedDifference = Number(
    calculator.effectiveHcapDifference ??
      calculator.EffectiveHcapDifference ??
      calculator.hcapDifference ??
      calculator.HcapDifference
  );
  if (!Number.isFinite(suggestedDifference)) {
    throw new Error('RTO did not return a handicap difference.');
  }
  const oddsRows = cachedOdds ? (JSON.parse(cachedOdds) as OddsReferenceRow[]) : readOddsRows(oddsResponse);
  if (!cachedOdds) {
    cacheReference(oddsCacheKey, oddsRows);
  }
  return {
    difference: String(resolvePlayedHandicapDifference(enteredHandicap, oddsRows, suggestedDifference)),
    type: 'H'
  };
}

function readOddsRows(response: GoogleAppsScript.URL_Fetch.HTTPResponse | undefined): OddsReferenceRow[] {
  const body = response ? parseRtoResponse(response) : undefined;
  const rows = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.rows ?? body.Rows)
      ? ((body.rows ?? body.Rows) as OddsReferenceRow[])
      : undefined;
  if (!rows) {
    throw new Error('RTO returned an unreadable odds table.');
  }
  return rows;
}

function cacheReference(key: string, value: unknown): void {
  try {
    CacheService.getScriptCache().put(key, JSON.stringify(value), RTO_REFERENCE_CACHE_SECONDS);
  } catch (error) {
    console.warn(JSON.stringify({ event: 'reference_cache_skipped', key, error: safeErrorMessage(error) }));
  }
}

function oddsCalculatorPayload(record: QueueRecord, players: readonly ReviewedPlayer[]): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    courtID: record.courtId,
    sd: record.matchType,
    hl: 'H',
    piD_p1: players[0]?.id,
    piD_p2: players[record.matchType === 'D' ? 2 : 1]?.id,
    p1: players[0]?.handicap,
    p2: players[record.matchType === 'D' ? 2 : 1]?.handicap,
    includeTeamHandicaps: false,
    useFastAutoSuggest: true,
    effectiveDate: record.matchDate
  };
  if (record.matchType === 'D') {
    payload.piD_p1p = players[1]?.id;
    payload.piD_p2p = players[3]?.id;
    payload.p1P = players[1]?.handicap;
    payload.p2P = players[3]?.handicap;
  }
  return payload;
}

function saveRtoMatch(
  token: string,
  claims: Record<string, unknown>,
  record: QueueRecord,
  players: readonly ReviewedPlayer[],
  score: string,
  handicap: ResolvedHandicap,
  description: string,
  duplicateConfirmed: boolean
): number {
  const userId = Number(claims.sub);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('The RTO session has no valid user ID. Sign in again.');
  }
  const response = UrlFetchApp.fetch(`${RTO_API}/Match/save`, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${token}` },
    payload: JSON.stringify({
      CourtID: record.courtId,
      MatchDate: record.matchDate,
      P1: players[0]?.id,
      P2: record.matchType === 'D' ? players[1]?.id : 0,
      P3: players[record.matchType === 'D' ? 2 : 1]?.id,
      P4: record.matchType === 'D' ? players[3]?.id : 0,
      Score: score,
      HcapDifference: handicap.difference,
      HL: handicap.type,
      SC: matchWeighting(record),
      Description: description,
      UserId: userId,
      Source: 'rto_web_site',
      ResultMode: 'NONE',
      SpecialResultAwardedTeam: null,
      SpecialResultIntendedSets: null,
      SpecialResultGamesPerSet: null,
      DuplicateConfirmed: duplicateConfirmed
    }),
    muteHttpExceptions: true
  });
  const status = response.getResponseCode();
  const bodyText = response.getContentText();
  if (status < 200 || status >= 300) {
    const detail = rtoErrorDetail(bodyText);
    const rejected = status >= 400 && status < 500 && status !== 408;
    const existingMatchId = status === 409 ? findExistingMatchId(token, record, players) : undefined;
    const message =
      status === 409
        ? [DUPLICATE_MATCH_MESSAGE, existingMatchId ? `RTO already has match ${existingMatchId}.` : '', detail]
            .filter(Boolean)
            .join(' ')
        : rejected
          ? detail || `RTO rejected the match with HTTP ${status}.`
          : `RTO returned HTTP ${status}; the submission outcome is unknown. Reconcile in RTO.`;
    throw new RtoMatchSaveError(message, rejected, status);
  }
  let body: unknown;
  try {
    body = bodyText ? (JSON.parse(bodyText) as unknown) : undefined;
  } catch {
    throw new RtoMatchSaveError(
      `RTO returned HTTP ${status} without a readable match ID. Reconcile in RTO.`,
      false,
      status
    );
  }
  const responseBody = isRecord(body) ? body : {};
  const matchId = Number(
    isRecord(body) ? (responseBody.matchID ?? responseBody.matchId ?? responseBody.MatchID) : body
  );
  if (!Number.isInteger(matchId) || matchId <= 0) {
    throw new RtoMatchSaveError('RTO did not return a match ID. Reconcile in RTO.', false);
  }
  return matchId;
}

function findExistingMatchId(
  token: string,
  record: QueueRecord,
  players: readonly ReviewedPlayer[]
): number | undefined {
  const doubles = record.matchType === 'D';
  const query = [
    ['CourtID', record.courtId],
    ['MatchDate', record.matchDate],
    ['P1', players[0]?.id],
    ['P2', doubles ? players[1]?.id : undefined],
    ['P3', players[doubles ? 2 : 1]?.id],
    ['P4', doubles ? players[3]?.id : undefined]
  ]
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join('&');
  try {
    const response = rtoGet(`/Match/search?${query}`, token);
    const matches = Array.isArray(response)
      ? response
      : isRecord(response)
        ? [response.rows, response.Rows, response.items, response.Items].find(Array.isArray)
        : undefined;
    return (matches ?? [])
      .map(match => (isRecord(match) ? Number(match.matchID ?? match.matchId ?? match.MatchID) : Number.NaN))
      .find(matchId => Number.isInteger(matchId) && matchId > 0);
  } catch {
    return undefined;
  }
}

export function rtoErrorDetail(bodyText: string): string {
  let body: unknown;
  try {
    body = JSON.parse(bodyText) as unknown;
  } catch {
    return bodyText.trim().slice(0, 500);
  }
  if (typeof body === 'string') {
    return body.trim().slice(0, 500);
  }
  if (!isRecord(body)) {
    return '';
  }
  const errors = body.errors ?? body.Errors;
  const fieldErrors = isRecord(errors)
    ? Object.values(errors)
        .flat()
        .filter(value => typeof value === 'string')
    : [];
  return [readString(body, 'message', 'Message', 'error', 'Error', 'title', 'Title'), ...fieldErrors]
    .filter(Boolean)
    .join(' ')
    .slice(0, 500);
}

export function matchWeighting(record: Pick<QueueRecord, 'sanctioned' | 'tournament'>): 'X' | 'C' | 'S' {
  if (record.sanctioned) {
    return 'X';
  }
  return record.tournament ? 'C' : 'S';
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : 'RTO submission failed.';
}

function numericUserId(claims: Record<string, unknown>): number | undefined {
  const userId = Number(claims.sub);
  return Number.isInteger(userId) && userId > 0 ? userId : undefined;
}

function auditLog(event: string, fields: Record<string, unknown>, severity: 'info' | 'warning' = 'info'): void {
  const entry = JSON.stringify({ event, ...fields });
  if (severity === 'warning') {
    console.warn(entry);
  } else {
    console.log(entry);
  }
}

function loginAuditContext(payload: unknown): Record<string, string> {
  if (!isRecord(payload)) {
    return {};
  }
  const context = isRecord(payload.clientContext) ? payload.clientContext : {};
  const field = (value: unknown, maximumLength: number): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim().slice(0, maximumLength) : undefined;
  return Object.fromEntries(
    [
      ['identifier', field(payload.identifier, 100)],
      ['userAgent', field(context.userAgent, 300)],
      ['language', field(context.language, 30)],
      ['timeZone', field(context.timeZone, 100)]
    ].filter((entry): entry is [string, string] => Boolean(entry[1]))
  );
}

function authorize(token: string): Record<string, unknown> {
  const now = Date.now();
  const claims = decodeJwtPayload(token);
  validateSessionClaims(claims, now);
  const cache = CacheService.getScriptCache();
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token);
  const cacheKey = `admin:validated-session:${Utilities.base64EncodeWebSafe(digest)}`;
  if (cache.get(cacheKey)) {
    return claims;
  }
  enforceAdminRateLimit(
    'token-validation',
    TOKEN_VALIDATION_RATE_LIMIT,
    'Score Review is busy. Try again in a minute.'
  );
  const validation = rtoRequest('/User/validate-token', { token }, token);
  requireValidatedToken(validation);
  const cacheSeconds = validatedSessionCacheSeconds(claims, now);
  if (cacheSeconds > 0) {
    cache.put(cacheKey, '1', cacheSeconds);
  }
  return claims;
}

export function validatedSessionCacheSeconds(claims: Record<string, unknown>, now: number): number {
  return Math.max(0, Math.min(VALIDATED_SESSION_CACHE_SECONDS, Math.floor(Number(claims.exp) - now / 1_000)));
}

function enforceAdminRateLimit(key: string, limit: number, message: string): void {
  const cache = CacheService.getScriptCache();
  const cacheKey = `admin:${key}`;
  const count = Number(cache.get(cacheKey) ?? 0);
  if (count >= limit) {
    throw new Error(message);
  }
  cache.put(cacheKey, String(count + 1), RATE_LIMIT_SECONDS);
}

export function requireValidatedToken(validation: Record<string, unknown>): string {
  const token = readString(validation, 'token', 'Token');
  if (!token) {
    throw new Error('The RTO session is invalid. Sign in again.');
  }
  return token;
}

export function validateSessionClaims(claims: Record<string, unknown>, now: number): void {
  const expiresAt = Number(claims.exp) * 1_000;
  const validFrom = Number(claims.nbf) * 1_000;
  if (!Number.isFinite(expiresAt) || expiresAt <= now || !Number.isFinite(validFrom) || validFrom > now) {
    throw new Error('The RTO session has expired. Sign in again.');
  }
  const serializedRoles = claims.rtoRole;
  const roles = Array.isArray(serializedRoles) ? serializedRoles : [serializedRoles];
  const isBostonMatchAdmin = roles.some(serializedRole => {
    if (typeof serializedRole !== 'string') {
      return false;
    }
    try {
      const role = JSON.parse(serializedRole) as RtoRole;
      return (
        role.Role === 'ADM-MATCH' &&
        role.OrgID === BOSTON_ORGANIZATION_ID &&
        (!role.StartDate || new Date(role.StartDate).getTime() <= now) &&
        (!role.EndDate || new Date(role.EndDate).getTime() >= now)
      );
    } catch {
      return false;
    }
  });
  if (!isBostonMatchAdmin) {
    throw new Error('This RTO account is not a Boston match administrator.');
  }
}

function rtoRequest(path: string, payload: object, token?: string): Record<string, unknown> {
  const body = rtoPost(path, payload, token);
  if (!isRecord(body)) {
    throw new Error('RTO returned an unreadable response.');
  }
  return body;
}

function rtoPost(path: string, payload: object, token?: string): unknown {
  const { url, ...options } = rtoPostRequest(path, payload, token);
  return parseRtoResponse(UrlFetchApp.fetch(url, options));
}

function rtoGet(path: string, token: string): unknown {
  const { url, ...options } = rtoGetRequest(path, token);
  return parseRtoResponse(UrlFetchApp.fetch(url, options));
}

function rtoPostRequest(path: string, payload: object, token?: string): GoogleAppsScript.URL_Fetch.URLFetchRequest {
  return {
    url: `${RTO_API}${path}`,
    method: 'post',
    contentType: 'application/json',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
}

function rtoGetRequest(path: string, token: string): GoogleAppsScript.URL_Fetch.URLFetchRequest {
  return {
    url: `${RTO_API}${path}`,
    method: 'get',
    headers: { Authorization: `Bearer ${token}` },
    muteHttpExceptions: true
  };
}

function parseRtoResponse(response: GoogleAppsScript.URL_Fetch.HTTPResponse): unknown {
  const status = response.getResponseCode();
  const bodyText = response.getContentText();
  let body: unknown = {};
  if (bodyText) {
    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      if (status >= 200 && status < 300) {
        throw new Error('RTO returned an unreadable response.');
      }
    }
  }
  if (status < 200 || status >= 300) {
    const errorBody = isRecord(body) ? body : {};
    const code = readString(errorBody, 'code', 'Code');
    if (code === 'INVALID_CREDENTIALS' || status === 401) {
      throw new Error('The RTO sign-in details were not recognized.');
    }
    if (status === 403) {
      throw new Error('This RTO account cannot sign in here.');
    }
    if (status === 429) {
      throw new Error('Too many sign-in attempts. Try again later.');
    }
    throw new Error('The RTO request could not be completed.');
  }
  return body;
}

function directoryPlayer(
  value: unknown,
  primaryOrgByPersonId: ReadonlyMap<number, number>,
  isBostonOverride = false
): DirectoryPlayer | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = value.playerID ?? value.playerId ?? value.PlayerID;
  const name = cleanPlayerName(
    readString(
      value,
      'nameFirstLastTagHand',
      'NameFirstLastTagHand',
      'nameFirstLastTag',
      'NameFirstLastTag',
      'nameFirstLast',
      'NameFirstLast'
    ) ||
      [readString(value, 'nameFirst', 'NameFirst'), readString(value, 'nameLast', 'NameLast')].filter(Boolean).join(' ')
  );
  const handicap = Number(value.hcapLong ?? value.HcapLong ?? value.hcap ?? value.Hcap ?? value.HCap);
  if ((typeof id !== 'string' && typeof id !== 'number') || !name || !Number.isFinite(handicap)) {
    return undefined;
  }
  const personId = Number(value.personID ?? value.personId ?? value.PersonID);
  const primaryOrgId = primaryOrgByPersonId.get(personId);
  return {
    id: String(id),
    name,
    handicap,
    isBoston:
      isBostonOverride ||
      primaryOrgId === BOSTON_ORGANIZATION_ID ||
      organizationIds(value).includes(BOSTON_ORGANIZATION_ID)
  };
}

function cleanPlayerName(value: string): string {
  return value.replace(/\s*\((?:Singles|Doubles)(?: W\/Hand)?\)\s*$/i, '').trim();
}

function organizationIds(value: Record<string, unknown>): number[] {
  const directIds = [
    value.orgID,
    value.orgId,
    value.OrgID,
    value.OrgId,
    value.primaryOrgID,
    value.primaryOrgId,
    value.PrimaryOrgID,
    value.PrimaryOrgId
  ];
  const nestedIds = ['orgs', 'Orgs', 'organizations', 'Organizations', 'memberships', 'Memberships'].flatMap(key => {
    const collection = value[key];
    if (!Array.isArray(collection)) {
      return [];
    }
    return collection.flatMap(item => {
      if (!isRecord(item)) {
        return [];
      }
      return [item.orgID, item.orgId, item.OrgID, item.OrgId];
    });
  });
  return [...directIds, ...nestedIds].map(Number).filter(Number.isFinite);
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const encodedPayload = token.split('.')[1];
  if (!encodedPayload) {
    throw new Error('The RTO session is invalid. Sign in again.');
  }
  try {
    const bytes = Utilities.base64DecodeWebSafe(encodedPayload);
    return JSON.parse(Utilities.newBlob(bytes).getDataAsString()) as Record<string, unknown>;
  } catch {
    throw new Error('The RTO session is invalid. Sign in again.');
  }
}

function readQueueIndex(spreadsheetId: string): QueueIndex | undefined {
  return parseQueueIndex(
    PropertiesService.getScriptProperties().getProperty(QUEUE_INDEX_PROPERTY_PREFIX + spreadsheetId)
  );
}

function writeQueueIndex(spreadsheetId: string, index: QueueIndex): void {
  PropertiesService.getScriptProperties().setProperty(
    QUEUE_INDEX_PROPERTY_PREFIX + spreadsheetId,
    JSON.stringify(index)
  );
}

function recordHistoryTab(spreadsheetId: string, tabName: string): void {
  const index = readQueueIndex(spreadsheetId);
  if (index) {
    writeQueueIndex(spreadsheetId, withHistoryTab(index, tabName));
  }
}

function recordsFromSheet(sheet: GoogleAppsScript.Spreadsheet.Sheet): QueueRecord[] {
  if (sheet.getLastRow() < 2) {
    return [];
  }
  return sheet
    .getRange(2, 1, sheet.getLastRow() - 1, QUEUE_HEADERS.length)
    .getDisplayValues()
    .filter(row => row.some(Boolean))
    .map(row => recordFromRow(row));
}

function validateQueuePageRequest(request: unknown): { readonly view: QueueView; readonly page: number } {
  if (!isRecord(request) || (request.view !== 'review' && request.view !== 'history')) {
    throw new Error('Choose a valid queue view.');
  }
  const page = Number(request.page);
  if (!Number.isSafeInteger(page) || page < 0 || page > 100_000) {
    throw new Error('Choose a valid history page.');
  }
  return { view: request.view, page };
}

function recordFromRow(row: readonly string[]): QueueRecord {
  const value = (header: (typeof QUEUE_HEADERS)[number]): string => row[QUEUE_HEADERS.indexOf(header)] ?? '';
  return {
    submissionId: value('Submission ID'),
    requestId: value('Request ID'),
    submittedAt: value('Submitted At'),
    matchDate: value('Match Date'),
    courtId: Number(value('Court ID')),
    matchType: value('Match Type') === 'D' ? 'D' : 'S',
    side1Player1: value('Side 1 Player 1'),
    side1Player2: value('Side 1 Player 2'),
    side2Player1: value('Side 2 Player 1'),
    side2Player2: value('Side 2 Player 2'),
    scoreOriginal: value('Score Original'),
    handicapEntryType: value('Handicap Entry Type') === 'difference' ? 'difference' : 'odds',
    handicapOriginal: value('Handicap Original'),
    tournament: value('Tournament').toLowerCase() === 'true',
    status: queueStatus(value('Status')),
    scoreNormalized: value('Score Normalized'),
    rtoPlayerIds: value('RTO Player IDs'),
    rtoHandicapDifference: value('RTO Handicap Difference'),
    rtoMatchId: value('RTO Match ID'),
    lastError: value('Last Error'),
    updatedAt: value('Updated At'),
    sanctioned: value('Sanctioned').toLowerCase() === 'true'
  };
}

function queueStatus(value: string): QueueRecord['status'] {
  if (value === 'Ready') {
    return 'Needs reconciliation';
  }
  if (value === 'Needs reconciliation' || value === 'Submitted' || value === 'Failed' || value === 'Withdrawn') {
    return value;
  }
  return 'Needs review';
}

/**
 * Writes the review columns of `record`, from Status through Updated At, to `rowNumber` in one call.
 */
function writeReviewColumns(sheet: GoogleAppsScript.Spreadsheet.Sheet, rowNumber: number, record: QueueRecord): void {
  const first = QUEUE_HEADERS.indexOf('Status');
  const values = queueRecordToRow(record).slice(first, QUEUE_HEADERS.indexOf('Updated At') + 1);
  sheet.getRange(rowNumber, first + 1, 1, values.length).setValues([values]);
}

function validateLoginRequest(payload: unknown): LoginRequest {
  if (!isRecord(payload)) {
    throw new Error('Enter your RTO number or email and password.');
  }
  return {
    identifier: requiredString(payload.identifier, 'RTO number or email'),
    password: requiredString(payload.password, 'Password')
  };
}

function validateReviewedSubmission(payload: unknown): ReviewedSubmissionRequest {
  if (!isRecord(payload) || !Array.isArray(payload.players)) {
    throw new Error('The reviewed submission is incomplete.');
  }
  const score = requiredString(payload.score, 'Score');
  if (score.length > 100) {
    throw new Error('The score is too long.');
  }
  const invalidScore = scoreError(score);
  if (invalidScore) {
    throw new Error(invalidScore);
  }
  const players = payload.players.map(player => {
    if (!isRecord(player)) {
      throw new Error('Choose every RTO player.');
    }
    const id = Number(player.id);
    const handicap = Number(player.handicap);
    if (!Number.isInteger(id) || id <= 0 || !Number.isFinite(handicap)) {
      throw new Error('Choose every RTO player.');
    }
    return { id, handicap };
  });
  if (new Set(players.map(player => player.id)).size !== players.length) {
    throw new Error('Choose a different RTO player for each position.');
  }
  const handicap = typeof payload.handicap === 'string' ? payload.handicap.trim() : '';
  if (handicap.length > 60) {
    throw new Error('The handicap is too long.');
  }
  const sanctionedMatch = typeof payload.sanctionedMatch === 'string' ? payload.sanctionedMatch.trim() : '';
  if (sanctionedMatch.length > 500) {
    throw new Error('The sanctioned match is too long.');
  }
  const tabName = requiredString(payload.tabName, 'Queue week');
  if (!WEEK_SHEET_NAME_PATTERN.test(tabName)) {
    throw new Error('That submission could not be found.');
  }
  return {
    submissionId: requiredString(payload.submissionId, 'Submission ID'),
    tabName,
    players,
    score,
    handicap,
    sanctionedMatch,
    duplicateConfirmed: payload.duplicateConfirmed === true
  };
}

function validateQueuedMatchReference(payload: unknown): { readonly submissionId: string; readonly tabName: string } {
  if (!isRecord(payload)) {
    throw new Error('That submission could not be found.');
  }
  const tabName = requiredString(payload.tabName, 'Queue week');
  if (!WEEK_SHEET_NAME_PATTERN.test(tabName)) {
    throw new Error('That submission could not be found.');
  }
  return { submissionId: requiredString(payload.submissionId, 'Submission ID'), tabName };
}

function validReviewedHandicap(record: QueueRecord, handicap: string): string {
  if (handicap && record.handicapEntryType === 'difference' && !/^[+-]?\d+(?:\.\d+)?$/.test(handicap)) {
    throw new Error('Enter the handicap difference as a number.');
  }
  if (handicap && record.handicapEntryType === 'odds' && !isValidOdds(handicap)) {
    throw new Error('Enter two valid odds scores, such as -15/15 or -h15/15.');
  }
  return handicap;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function requiredMatchType(value: unknown): 'S' | 'D' {
  if (value === 'S' || value === 'D') {
    return value;
  }
  throw new Error('Choose singles or doubles.');
}

function readString(value: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    if (typeof value[key] === 'string') {
      return value[key];
    }
  }
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
