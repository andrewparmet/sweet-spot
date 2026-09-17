import {
  HANDICAP_ENTRY_TYPES,
  isValidOdds,
  isValidScore,
  MATCH_TYPES,
  type HandicapEntryType,
  type MatchSubmissionResponse,
  type MatchType,
  type UndoSubmissionRequest,
  type UndoSubmissionResponse,
  type ValidatedMatchSubmission
} from '../../../packages/shared/src/match.ts';
import {
  INITIAL_QUEUE_STATUS,
  QUEUE_HEADERS,
  queueRecordToRow,
  type QueueLocation,
  type QueueRecord
} from '../../../packages/shared/src/queue.ts';

const SPREADSHEET_ID_PROPERTY = 'SWEET_SPOT_SPREADSHEET_ID';
const ENVIRONMENT_PROPERTY = 'SWEET_SPOT_ENVIRONMENT';
const BOSTON_COURT_ID = 36;
const BOSTON_TIME_ZONE = 'America/New_York';
const WEEK_SHEET_NAME_PATTERN = /^\d{4}-W\d{2}$/;
const MAX_TEXT_LENGTH = 100;
const MAX_SCORE_LENGTH = 100;
const MAX_HANDICAP_LENGTH = 60;
const THROTTLE_SECONDS = 3;

export function doGet(): GoogleAppsScript.HTML.HtmlOutput {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Match Entry')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

export function setup(environment: 'production' | 'staging'): string {
  const lock = LockService.getScriptLock();
  lock.waitLock(10_000);
  try {
    return setupLocked(environment);
  } finally {
    lock.releaseLock();
  }
}

export function ensureSetup(environment: 'production' | 'staging'): void {
  const properties = PropertiesService.getScriptProperties();
  const configuredEnvironment = properties.getProperty(ENVIRONMENT_PROPERTY);
  const spreadsheetId = properties.getProperty(SPREADSHEET_ID_PROPERTY);
  if (configuredEnvironment === environment && spreadsheetId) {
    return;
  }
  setup(environment);
}

function setupLocked(environment: 'production' | 'staging'): string {
  const properties = PropertiesService.getScriptProperties();
  const configuredEnvironment = properties.getProperty(ENVIRONMENT_PROPERTY);
  if (configuredEnvironment && configuredEnvironment !== environment) {
    throw new Error(`This project is already configured for ${configuredEnvironment}.`);
  }
  properties.setProperty(ENVIRONMENT_PROPERTY, environment);
  const existingId = properties.getProperty(SPREADSHEET_ID_PROPERTY);
  if (existingId) {
    const existingSpreadsheet = SpreadsheetApp.openById(existingId);
    ensureWeekSheet(existingSpreadsheet, currentWeekTabName());
    console.log(existingSpreadsheet.getUrl());
    return existingSpreadsheet.getUrl();
  }

  const suffix = environment === 'staging' ? ' (Staging)' : '';
  const spreadsheet = SpreadsheetApp.create(`Sweet Spot Match Queue${suffix}`);
  properties.setProperty(SPREADSHEET_ID_PROPERTY, spreadsheet.getId());
  ensureWeekSheet(spreadsheet, currentWeekTabName());
  console.log(spreadsheet.getUrl());
  return spreadsheet.getUrl();
}

export function submitMatch(payload: unknown): MatchSubmissionResponse {
  if (hasHoneypotValue(payload)) {
    return {
      submissionId: Utilities.getUuid(),
      accepted: true
    };
  }

  const submission = validateSubmission(payload);
  const lock = LockService.getScriptLock();
  lock.waitLock(10_000);

  try {
    const spreadsheet = getQueueSpreadsheet();
    const existingSubmissionId = findSubmissionByRequestId(spreadsheet, submission.requestId);
    if (existingSubmissionId) {
      return {
        submissionId: existingSubmissionId,
        accepted: true
      };
    }

    enforceThrottle(submission.clientId);
    const now = new Date();
    const submissionId = Utilities.getUuid();
    const matchDate = Utilities.formatDate(now, BOSTON_TIME_ZONE, 'yyyy-MM-dd');
    const timestamp = Utilities.formatDate(now, BOSTON_TIME_ZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
    const sheet = ensureWeekSheet(spreadsheet, isoWeekTabName(matchDate));

    const record: QueueRecord = {
      submissionId,
      requestId: submission.requestId,
      submittedAt: timestamp,
      matchDate,
      courtId: BOSTON_COURT_ID,
      matchType: submission.matchType,
      side1Player1: escapeForSheet(submission.side1Player1),
      side1Player2: escapeForSheet(submission.side1Player2),
      side2Player1: escapeForSheet(submission.side2Player1),
      side2Player2: escapeForSheet(submission.side2Player2),
      scoreOriginal: escapeForSheet(submission.score),
      handicapEntryType: submission.handicapType,
      handicapOriginal: escapeForSheet(submission.handicap),
      tournament: submission.tournament,
      status: INITIAL_QUEUE_STATUS,
      scoreNormalized: escapeForSheet(normalizeScore(submission.score)),
      rtoPlayerIds: '',
      rtoHandicapDifference: '',
      rtoMatchId: '',
      lastError: '',
      updatedAt: timestamp
    };
    sheet.appendRow(queueRecordToRow(record));

    return {
      submissionId,
      accepted: true
    };
  } finally {
    lock.releaseLock();
  }
}

export function undoSubmission(payload: unknown): UndoSubmissionResponse {
  const request = validateUndoSubmission(payload);
  const lock = LockService.getScriptLock();
  lock.waitLock(10_000);

  try {
    const spreadsheet = getQueueSpreadsheet();
    const location = findSubmission(spreadsheet, request.submissionId, request.requestId);
    if (!location) {
      throw new Error('That submission could not be found.');
    }

    const sheet = spreadsheet.getSheetByName(location.tabName);
    if (!sheet) {
      throw new Error('That submission could not be found.');
    }
    const statusColumn = QUEUE_HEADERS.indexOf('Status') + 1;
    const updatedAtColumn = QUEUE_HEADERS.indexOf('Updated At') + 1;
    const statusCell = sheet.getRange(location.rowNumber, statusColumn);
    const status = String(statusCell.getValue());
    if (status === 'Submitted') {
      throw new Error('That score has already been submitted to RTO and can no longer be undone here.');
    }
    if (status !== 'Withdrawn') {
      const timestamp = Utilities.formatDate(new Date(), BOSTON_TIME_ZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
      statusCell.setValue('Withdrawn');
      sheet.getRange(location.rowNumber, updatedAtColumn).setValue(timestamp);
    }
    return { withdrawn: true };
  } finally {
    lock.releaseLock();
  }
}

export function validateSubmission(payload: unknown): ValidatedMatchSubmission {
  if (!isRecord(payload)) {
    throw new Error('The match submission is missing.');
  }

  const requestId = requiredText(payload.requestId, 'Request ID', 64);
  const clientId = requiredText(payload.clientId, 'Client ID', 64);
  const matchTypeValue = String(payload.matchType ?? '')
    .trim()
    .toUpperCase();
  if (!isIncluded(MATCH_TYPES, matchTypeValue)) {
    throw new Error('Choose singles or doubles.');
  }
  const matchType: MatchType = matchTypeValue;

  const handicapTypeValue = String(payload.handicapType ?? '')
    .trim()
    .toLowerCase();
  if (!isIncluded(HANDICAP_ENTRY_TYPES, handicapTypeValue)) {
    throw new Error('Choose odds or handicap difference.');
  }
  const handicapType: HandicapEntryType = handicapTypeValue;

  const side1Player1 = requiredText(payload.side1Player1, 'Side 1 player', MAX_TEXT_LENGTH);
  const side2Player1 = requiredText(payload.side2Player1, 'Side 2 player', MAX_TEXT_LENGTH);
  const side1Player2 = optionalText(payload.side1Player2, 'Side 1 partner', MAX_TEXT_LENGTH);
  const side2Player2 = optionalText(payload.side2Player2, 'Side 2 partner', MAX_TEXT_LENGTH);
  if (matchType === 'D' && (!side1Player2 || !side2Player2)) {
    throw new Error('Enter both doubles partners.');
  }

  const score = requiredText(payload.score, 'Score', MAX_SCORE_LENGTH);
  if (!isValidScore(score)) {
    throw new Error('Enter game scores like 6-2,6-1 or 10-8.');
  }
  const handicap = optionalText(payload.handicap, 'Handicap played', MAX_HANDICAP_LENGTH);
  if (handicap && handicapType === 'difference' && !/^[+-]?\d+(?:\.\d+)?$/.test(handicap)) {
    throw new Error('Enter the handicap difference as a number.');
  }
  if (handicap && handicapType === 'odds' && !isValidOdds(handicap)) {
    throw new Error('Enter two valid odds scores, such as -15/15 or -h15/15.');
  }

  return {
    requestId,
    clientId,
    matchType,
    side1Player1,
    side1Player2: matchType === 'D' ? side1Player2 : '',
    side2Player1,
    side2Player2: matchType === 'D' ? side2Player2 : '',
    score,
    handicapType,
    handicap,
    tournament: payload.tournament === true
  };
}

export function validateUndoSubmission(payload: unknown): UndoSubmissionRequest {
  if (!isRecord(payload)) {
    throw new Error('The undo request is missing.');
  }
  return {
    submissionId: requiredText(payload.submissionId, 'Submission ID', 64),
    requestId: requiredText(payload.requestId, 'Request ID', 64)
  };
}

export function normalizeScore(score: string): string {
  return score
    .trim()
    .replace(/[–—]/g, '-')
    .replace(/\s*,\s*/g, ' ')
    .replace(/(\d)\s*-\s*(\d)/g, '$1/$2')
    .replace(/\s+/g, ' ');
}

export function escapeForSheet(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

export function isoWeekTabName(matchDate: string): string {
  const parts = matchDate.split('-').map(Number);
  const year = parts[0];
  const month = parts[1];
  const dayOfMonth = parts[2];
  if (!year || !month || !dayOfMonth) {
    throw new Error('Invalid match date.');
  }

  const date = new Date(Date.UTC(year, month - 1, dayOfMonth));
  const dayOfWeek = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayOfWeek);
  const isoYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

function hasHoneypotValue(payload: unknown): boolean {
  return isRecord(payload) && Boolean(payload.website);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIncluded<const T extends readonly string[]>(values: T, value: string): value is T[number] {
  return values.includes(value as T[number]);
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  const text = optionalText(value, label, maxLength);
  if (!text) {
    throw new Error(`${label} is required.`);
  }
  return text;
}

function optionalText(value: unknown, label: string, maxLength: number): string {
  const text = String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  if (text.length > maxLength) {
    throw new Error(`${label} is too long.`);
  }
  return text;
}

function enforceThrottle(clientId: string): void {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, clientId);
  const cacheKey = `submit:${Utilities.base64EncodeWebSafe(digest)}`;
  const cache = CacheService.getScriptCache();
  if (cache.get(cacheKey)) {
    throw new Error('Please wait a moment before submitting another score.');
  }
  cache.put(cacheKey, '1', THROTTLE_SECONDS);
}

function getQueueSpreadsheet(): GoogleAppsScript.Spreadsheet.Spreadsheet {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty(SPREADSHEET_ID_PROPERTY);
  if (!spreadsheetId) {
    throw new Error('Sweet Spot has not been configured.');
  }
  return SpreadsheetApp.openById(spreadsheetId);
}

function currentWeekTabName(): string {
  const matchDate = Utilities.formatDate(new Date(), BOSTON_TIME_ZONE, 'yyyy-MM-dd');
  return isoWeekTabName(matchDate);
}

function ensureWeekSheet(
  spreadsheet: GoogleAppsScript.Spreadsheet.Spreadsheet,
  tabName: string
): GoogleAppsScript.Spreadsheet.Sheet {
  let sheet = spreadsheet.getSheetByName(tabName);
  if (!sheet) {
    const sheets = spreadsheet.getSheets();
    const firstSheet = sheets[0];
    sheet = firstSheet && sheets.length === 1 && sheetIsEmpty(firstSheet) ? firstSheet : spreadsheet.insertSheet();
    sheet.setName(tabName);
  }

  if (sheet.getLastRow() === 0) {
    sheet.appendRow([...QUEUE_HEADERS]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, QUEUE_HEADERS.length).setFontWeight('bold');
  }
  return sheet;
}

function sheetIsEmpty(sheet: GoogleAppsScript.Spreadsheet.Sheet): boolean {
  return (
    sheet.getLastRow() === 0 ||
    (sheet.getLastRow() === 1 && sheet.getLastColumn() === 1 && !sheet.getRange(1, 1).getValue())
  );
}

function findSubmissionByRequestId(spreadsheet: GoogleAppsScript.Spreadsheet.Spreadsheet, requestId: string): string {
  for (const sheet of spreadsheet.getSheets()) {
    if (!WEEK_SHEET_NAME_PATTERN.test(sheet.getName()) || sheet.getLastRow() < 2) {
      continue;
    }
    const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
    const match = values.find(row => row[1] === requestId);
    if (match) {
      return String(match[0]);
    }
  }
  return '';
}

function findSubmission(
  spreadsheet: GoogleAppsScript.Spreadsheet.Spreadsheet,
  submissionId: string,
  requestId: string
): QueueLocation | undefined {
  for (const sheet of spreadsheet.getSheets()) {
    if (!WEEK_SHEET_NAME_PATTERN.test(sheet.getName()) || sheet.getLastRow() < 2) {
      continue;
    }
    const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
    const rowOffset = values.findIndex(row => row[0] === submissionId && row[1] === requestId);
    if (rowOffset >= 0) {
      return {
        tabName: sheet.getName(),
        rowNumber: rowOffset + 2
      };
    }
  }
  return undefined;
}
