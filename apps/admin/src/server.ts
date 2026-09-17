import { QUEUE_HEADERS, type QueueRecord } from '../../../packages/shared/src/queue.ts';
import { isValidScore, normalizeScore } from '../../../packages/shared/src/match.ts';
import { resolvePlayedHandicapDifference } from './rto-match.ts';

const RTO_API = 'https://www.realtennisonline.com/v2/api';
const BOSTON_ORGANIZATION_ID = 36;
const BOSTON_TIME_ZONE = 'America/New_York';
const WEEK_SHEET_NAME_PATTERN = /^\d{4}-W\d{2}$/;
const LOGIN_RATE_LIMIT = 10;
const TOKEN_VALIDATION_RATE_LIMIT = 120;
const RATE_LIMIT_SECONDS = 60;

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
  readonly players: ReviewedPlayer[];
  readonly score: string;
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

export function loadAdminQueue(token: unknown, spreadsheetId: string): { readonly items: unknown[] } {
  authorize(requiredString(token, 'RTO session'));
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  const items = spreadsheet
    .getSheets()
    .filter(sheet => WEEK_SHEET_NAME_PATTERN.test(sheet.getName()))
    .flatMap(sheet => recordsFromSheet(sheet).map(record => ({ tabName: sheet.getName(), record })))
    .sort((left, right) => right.record.submittedAt.localeCompare(left.record.submittedAt));
  return { items };
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
  for (const directoryQuery of new Set([name, lastName(name)].filter(Boolean))) {
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
  const queries = new Set([name, lastName(name), ...resolvedNames].filter(Boolean));
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
  liveRtoSubmission: boolean,
  tournamentWeightCode: 'X' | 'C'
): { readonly submitted: true } {
  const sessionToken = requiredString(token, 'RTO session');
  const claims = authorize(sessionToken);
  const request = validateReviewedSubmission(payload);
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  const lock = LockService.getScriptLock();
  lock.waitLock(10_000);
  try {
    for (const sheet of spreadsheet.getSheets()) {
      if (!WEEK_SHEET_NAME_PATTERN.test(sheet.getName()) || sheet.getLastRow() < 2) {
        continue;
      }
      const submissionIds = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getDisplayValues();
      const rowOffset = submissionIds.findIndex(([submissionId]) => submissionId === request.submissionId);
      if (rowOffset < 0) {
        continue;
      }
      const rowNumber = rowOffset + 2;
      const record = recordFromRow(sheet.getRange(rowNumber, 1, 1, QUEUE_HEADERS.length).getDisplayValues()[0] ?? []);
      const expectedPlayerCount = record.matchType === 'D' ? 4 : 2;
      if (request.players.length !== expectedPlayerCount) {
        throw new Error(`Choose ${expectedPlayerCount} RTO players for this match.`);
      }
      if (record.status === 'Submitted' || record.status === 'Withdrawn') {
        throw new Error('That submission is no longer available for review.');
      }
      if (liveRtoSubmission && record.status === 'Ready') {
        throw new Error('This submission may already have reached RTO and must be reconciled before retrying.');
      }
      const timestamp = Utilities.formatDate(new Date(), BOSTON_TIME_ZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
      const playerIds = request.players.map(player => String(player.id));
      const score = normalizeScore(request.score);
      if (!liveRtoSubmission) {
        setCell(sheet, rowNumber, 'Status', 'Submitted');
        setCell(sheet, rowNumber, 'RTO Player IDs', playerIds.join(','));
        setCell(sheet, rowNumber, 'Score Normalized', score);
        setCell(sheet, rowNumber, 'RTO Match ID', `demo-${Date.now()}`);
        setCell(sheet, rowNumber, 'Updated At', timestamp);
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
        setCell(sheet, rowNumber, 'Status', 'Failed');
        setCell(sheet, rowNumber, 'Last Error', safeErrorMessage(error));
        setCell(sheet, rowNumber, 'Updated At', timestamp);
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
      setCell(sheet, rowNumber, 'Status', 'Ready');
      setCell(sheet, rowNumber, 'RTO Player IDs', playerIds.join(','));
      setCell(sheet, rowNumber, 'Score Normalized', score);
      setCell(sheet, rowNumber, 'RTO Handicap Difference', handicap.difference);
      setCell(sheet, rowNumber, 'Last Error', '');
      setCell(sheet, rowNumber, 'Updated At', timestamp);
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
        matchId = saveRtoMatch(sessionToken, claims, record, request.players, score, handicap, tournamentWeightCode);
      } catch (error) {
        if (error instanceof RtoMatchSaveError && error.rejected) {
          setCell(sheet, rowNumber, 'Status', 'Failed');
        }
        setCell(sheet, rowNumber, 'Last Error', safeErrorMessage(error));
        setCell(sheet, rowNumber, 'Updated At', timestamp);
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
      setCell(sheet, rowNumber, 'RTO Match ID', String(matchId));
      setCell(sheet, rowNumber, 'Status', 'Submitted');
      setCell(sheet, rowNumber, 'Updated At', timestamp);
      auditLog('match_submission', {
        environment: 'production',
        outcome: 'submitted',
        submissionId: request.submissionId,
        userId: numericUserId(claims),
        playerIds,
        matchId
      });
      return { submitted: true };
    }
  } finally {
    lock.releaseLock();
  }
  throw new Error('That submission could not be found.');
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

  const calculator = rtoPost('/Utility/odds/calculator', oddsCalculatorPayload(record, players), token);
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
  const oddsResponse = rtoGet(
    `/Utility/odds/getAll/${record.matchType}?effectiveDate=${encodeURIComponent(record.matchDate)}`,
    token
  );
  const oddsRows = Array.isArray(oddsResponse)
    ? oddsResponse
    : isRecord(oddsResponse) && Array.isArray(oddsResponse.rows ?? oddsResponse.Rows)
      ? ((oddsResponse.rows ?? oddsResponse.Rows) as unknown[])
      : undefined;
  if (!oddsRows) {
    throw new Error('RTO returned an unreadable odds table.');
  }
  return {
    difference: String(resolvePlayedHandicapDifference(enteredHandicap, oddsRows, suggestedDifference)),
    type: 'H'
  };
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
  tournamentWeightCode: 'X' | 'C'
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
      SC: record.tournament ? tournamentWeightCode : 'S',
      Description: '',
      UserId: userId,
      Source: 'rto_web_site',
      ResultMode: 'NONE',
      SpecialResultAwardedTeam: null,
      SpecialResultIntendedSets: null,
      SpecialResultGamesPerSet: null,
      DuplicateConfirmed: false
    }),
    muteHttpExceptions: true
  });
  const status = response.getResponseCode();
  const bodyText = response.getContentText();
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
  if (status < 200 || status >= 300) {
    const errorBody = isRecord(body) ? body : {};
    const detail = readString(errorBody, 'message', 'Message', 'error', 'Error');
    const rejected = status >= 400 && status < 500 && status !== 408;
    const message = rejected
      ? detail || `RTO rejected the match with HTTP ${status}.`
      : `RTO returned HTTP ${status}; the submission outcome is unknown. Reconcile in RTO.`;
    throw new RtoMatchSaveError(message, rejected, status);
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
  const claims = decodeJwtPayload(token);
  validateSessionClaims(claims, Date.now());
  enforceAdminRateLimit(
    'token-validation',
    TOKEN_VALIDATION_RATE_LIMIT,
    'Score Review is busy. Try again in a minute.'
  );
  const validation = rtoRequest('/User/validate-token', { token }, token);
  requireValidatedToken(validation);
  return claims;
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
  const response = UrlFetchApp.fetch(`${RTO_API}${path}`, {
    method: 'post',
    contentType: 'application/json',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  return parseRtoResponse(response);
}

function rtoGet(path: string, token: string): unknown {
  const response = UrlFetchApp.fetch(`${RTO_API}${path}`, {
    method: 'get',
    headers: { Authorization: `Bearer ${token}` },
    muteHttpExceptions: true
  });
  return parseRtoResponse(response);
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

function lastName(value: string): string {
  return value.trim().split(/\s+/).at(-1) || '';
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
    updatedAt: value('Updated At')
  };
}

function queueStatus(value: string): QueueRecord['status'] {
  if (value === 'Ready' || value === 'Submitted' || value === 'Failed' || value === 'Withdrawn') {
    return value;
  }
  return 'Needs review';
}

function setCell(
  sheet: GoogleAppsScript.Spreadsheet.Sheet,
  rowNumber: number,
  header: (typeof QUEUE_HEADERS)[number],
  value: string
): void {
  sheet.getRange(rowNumber, QUEUE_HEADERS.indexOf(header) + 1).setValue(value);
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
  if (score.length > 100 || !isValidScore(score)) {
    throw new Error('Enter game scores like 6-2,6-1 or 10-8.');
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
  return {
    submissionId: requiredString(payload.submissionId, 'Submission ID'),
    players,
    score
  };
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
