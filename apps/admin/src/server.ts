import { QUEUE_HEADERS, type QueueRecord } from '../../../packages/shared/src/queue.ts';

const RTO_API = 'https://www.realtennisonline.com/v2/api';
const BOSTON_ORGANIZATION_ID = 36;
const BOSTON_TIME_ZONE = 'America/New_York';
const WEEK_SHEET_NAME_PATTERN = /^\d{4}-W\d{2}$/;

interface LoginRequest {
  readonly identifier: string;
  readonly password: string;
}

interface DemoSubmissionRequest {
  readonly submissionId: string;
  readonly playerIds: string[];
}

interface RtoRole {
  readonly Role?: string;
  readonly OrgID?: number;
  readonly EndDate?: string;
}

interface DirectoryPlayer {
  readonly id: string;
  readonly name: string;
  readonly handicap: number;
}

export function doGet(): GoogleAppsScript.HTML.HtmlOutput {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Score review')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

export function adminLogin(payload: unknown): { readonly token: string } {
  const request = validateLoginRequest(payload);
  const response = rtoRequest('/User/login', {
    identifier: request.identifier,
    password: request.password
  });
  const token = readString(response, 'token', 'Token');
  if (!token) {
    throw new Error('RTO sign-in did not return a session.');
  }
  authorize(token);
  return { token };
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
): { readonly players: DirectoryPlayer[] } {
  const sessionToken = requiredString(token, 'RTO session');
  authorize(sessionToken);
  const type = requiredMatchType(matchType);
  if (!Array.isArray(playerNames) || playerNames.length < 2 || playerNames.length > 4) {
    throw new Error('The player search is incomplete.');
  }
  const names = playerNames.map(name => requiredString(name, 'Player name'));
  const playersById = new Map<string, DirectoryPlayer>();
  for (const name of names) {
    const response = rtoGet(
      `/Person/list/search/SD/${type}?text=${encodeURIComponent(name)}&initial=false&mustHavePrimaryOrg=false`,
      sessionToken
    );
    if (!Array.isArray(response)) {
      throw new Error('RTO returned an unreadable player directory.');
    }
    for (const candidate of response) {
      const player = directoryPlayer(candidate);
      if (player) {
        playersById.set(player.id, player);
      }
    }
  }
  return { players: [...playersById.values()] };
}

export function demoSubmitMatch(token: unknown, payload: unknown, spreadsheetId: string): { readonly submitted: true } {
  authorize(requiredString(token, 'RTO session'));
  const request = validateDemoSubmission(payload);
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
      const timestamp = Utilities.formatDate(new Date(), BOSTON_TIME_ZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
      setCell(sheet, rowNumber, 'Status', 'Submitted');
      setCell(sheet, rowNumber, 'RTO Player IDs', request.playerIds.join(','));
      setCell(sheet, rowNumber, 'RTO Match ID', `demo-${Date.now()}`);
      setCell(sheet, rowNumber, 'Updated At', timestamp);
      return { submitted: true };
    }
  } finally {
    lock.releaseLock();
  }
  throw new Error('That submission could not be found.');
}

function authorize(token: string): void {
  rtoRequest('/User/validate-token', { token }, token);
  const claims = decodeJwtPayload(token);
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
        (!role.EndDate || new Date(role.EndDate).getTime() >= Date.now())
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
  const response = UrlFetchApp.fetch(`${RTO_API}${path}`, {
    method: 'post',
    contentType: 'application/json',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const body = parseRtoResponse(response);
  if (!isRecord(body)) {
    throw new Error('RTO returned an unreadable response.');
  }
  return body;
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
    throw new Error(readString(errorBody, 'message', 'Message') || 'RTO sign-in could not be completed.');
  }
  return body;
}

function directoryPlayer(value: unknown): DirectoryPlayer | undefined {
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
  const handicap = Number(value.hcap ?? value.Hcap ?? value.HCap);
  if ((typeof id !== 'string' && typeof id !== 'number') || !name || !Number.isFinite(handicap)) {
    return undefined;
  }
  return { id: String(id), name, handicap };
}

function cleanPlayerName(value: string): string {
  return value.replace(/\s*\((?:Singles|Doubles)(?: W\/Hand)?\)\s*$/i, '').trim();
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

function validateDemoSubmission(payload: unknown): DemoSubmissionRequest {
  if (!isRecord(payload) || !Array.isArray(payload.playerIds)) {
    throw new Error('The demo submission is incomplete.');
  }
  return {
    submissionId: requiredString(payload.submissionId, 'Submission ID'),
    playerIds: payload.playerIds.map(playerId => requiredString(playerId, 'Player ID'))
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
