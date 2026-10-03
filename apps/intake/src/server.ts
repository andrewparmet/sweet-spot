import {
  normalizeScore,
  type MatchSubmissionResponse,
  type UndoSubmissionRequest,
  type UndoSubmissionResponse,
  type ValidatedMatchSubmission
} from '../../../packages/shared/src/match.ts';
export { normalizeScore } from '../../../packages/shared/src/match.ts';
import {
  QUEUE_HEADERS,
  queueRecordToRow,
  type QueueLocation,
  type QueueRecord
} from '../../../packages/shared/src/queue.ts';
import {
  BOSTON_COURT_ID,
  ensureWeekSheet,
  findSubmissionByRequestId,
  isoWeekTabName,
  newQueueRecord,
  recentWeekTabNames,
  rememberSubmission
} from '../../../packages/shared/src/queue-sheet.ts';
export { escapeForSheet, isoWeekTabName } from '../../../packages/shared/src/queue-sheet.ts';
import { requiredText, validateMatchFields } from '../../../packages/shared/src/submission.ts';

const SPREADSHEET_ID_PROPERTY = 'SWEET_SPOT_SPREADSHEET_ID';
const ENVIRONMENT_PROPERTY = 'SWEET_SPOT_ENVIRONMENT';
const STAGING_SEED_VERSION_PROPERTY = 'SWEET_SPOT_STAGING_SEED_VERSION';
const STAGING_SEED_VERSION = '1';
const BOSTON_TIME_ZONE = 'America/New_York';
const THROTTLE_SECONDS = 3;
const GLOBAL_THROTTLE_LIMIT = 30;
const GLOBAL_THROTTLE_SECONDS = 60;

export function doGet(bridgeChannel = ''): GoogleAppsScript.HTML.HtmlOutput {
  if (bridgeChannel) {
    if (!/^[a-zA-Z0-9-]{16,100}$/.test(bridgeChannel)) {
      throw new Error('Invalid bridge channel.');
    }
    const template = HtmlService.createTemplateFromFile('Bridge');
    template.channelJson = JSON.stringify(bridgeChannel);
    return template
      .evaluate()
      .setTitle('Match Entry Bridge')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
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
    if (environment === 'staging' && properties.getProperty(STAGING_SEED_VERSION_PROPERTY) !== STAGING_SEED_VERSION) {
      seedStagingHistory(SpreadsheetApp.openById(spreadsheetId));
      properties.setProperty(STAGING_SEED_VERSION_PROPERTY, STAGING_SEED_VERSION);
    }
    return;
  }
  setup(environment);
}

function seedStagingHistory(spreadsheet: GoogleAppsScript.Spreadsheet.Spreadsheet): void {
  const seedDate = new Date();
  seedDate.setDate(seedDate.getDate() - 7);
  const matchDate = Utilities.formatDate(seedDate, BOSTON_TIME_ZONE, 'yyyy-MM-dd');
  const timestamp = Utilities.formatDate(seedDate, BOSTON_TIME_ZONE, "yyyy-MM-dd'T'12:mm:ssXXX");
  const tabName = isoWeekTabName(matchDate);
  const sheet = ensureWeekSheet(spreadsheet, tabName);
  const samples = [
    {
      key: 'charlie-snoopy',
      matchType: 'S' as const,
      side1Player1: 'Charlie Brown',
      side1Player2: '',
      side2Player1: 'Snoopy',
      side2Player2: '',
      score: '6-4,6-2',
      handicap: ''
    },
    {
      key: 'lucy-marcie',
      matchType: 'S' as const,
      side1Player1: 'Lucy van Pelt',
      side1Player2: '',
      side2Player1: 'Marcie',
      side2Player2: '',
      score: '10-8',
      handicap: '-15/0'
    },
    {
      key: 'patty-franklin',
      matchType: 'D' as const,
      side1Player1: 'Peppermint Patty',
      side1Player2: 'Woodstock',
      side2Player1: 'Franklin Armstrong',
      side2Player2: 'Linus van Pelt',
      score: '6-3,4-6,6-4',
      handicap: '-h15/15'
    }
  ];
  const existingRequestIds = new Set(
    sheet.getLastRow() < 2
      ? []
      : sheet
          .getRange(2, QUEUE_HEADERS.indexOf('Request ID') + 1, sheet.getLastRow() - 1, 1)
          .getDisplayValues()
          .flat()
  );
  for (const sample of samples) {
    const requestId = `staging-seed-${tabName}-${sample.key}`;
    if (existingRequestIds.has(requestId)) {
      continue;
    }
    const submissionId = `staging-${Utilities.getUuid()}`;
    const record: QueueRecord = {
      submissionId,
      requestId,
      submittedAt: timestamp,
      matchDate,
      courtId: BOSTON_COURT_ID,
      matchType: sample.matchType,
      side1Player1: sample.side1Player1,
      side1Player2: sample.side1Player2,
      side2Player1: sample.side2Player1,
      side2Player2: sample.side2Player2,
      scoreOriginal: sample.score,
      handicapEntryType: 'odds',
      handicapOriginal: sample.handicap,
      tournament: false,
      status: 'Submitted',
      scoreNormalized: normalizeScore(sample.score),
      rtoPlayerIds: '',
      rtoHandicapDifference: '',
      rtoMatchId: `demo-${sample.key}`,
      lastError: '',
      updatedAt: timestamp,
      sanctioned: false
    };
    sheet.appendRow(queueRecordToRow(record));
  }
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
    const now = new Date();
    const matchDate = Utilities.formatDate(now, BOSTON_TIME_ZONE, 'yyyy-MM-dd');
    const spreadsheet = getQueueSpreadsheet();
    const existingSubmissionId = findSubmissionByRequestId(spreadsheet, submission.requestId, matchDate);
    if (existingSubmissionId) {
      return {
        submissionId: existingSubmissionId,
        accepted: true
      };
    }

    enforceThrottle(submission.clientId);
    const submissionId = Utilities.getUuid();
    const timestamp = Utilities.formatDate(now, BOSTON_TIME_ZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
    const sheet = ensureWeekSheet(spreadsheet, isoWeekTabName(matchDate));

    const record = newQueueRecord(submission, {
      submissionId,
      requestId: submission.requestId,
      timestamp,
      matchDate,
      sanctioned: false
    });
    sheet.appendRow(queueRecordToRow(record));
    rememberSubmission(submission.requestId, submissionId);

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
    if (status === 'Submitted' || status === 'Ready' || status === 'Needs reconciliation') {
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
  return {
    requestId,
    clientId,
    ...validateMatchFields(payload)
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

function hasHoneypotValue(payload: unknown): boolean {
  return isRecord(payload) && Boolean(payload.website);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function enforceThrottle(clientId: string): void {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, clientId);
  const cacheKey = `submit:${Utilities.base64EncodeWebSafe(digest)}`;
  const cache = CacheService.getScriptCache();
  if (cache.get(cacheKey)) {
    throw new Error('Please wait a moment before submitting another score.');
  }
  const globalCacheKey = 'submit:global';
  const globalCount = Number(cache.get(globalCacheKey) ?? 0);
  if (globalCount >= GLOBAL_THROTTLE_LIMIT) {
    throw new Error('Score entry is busy. Try again in a minute.');
  }
  cache.put(globalCacheKey, String(globalCount + 1), GLOBAL_THROTTLE_SECONDS);
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

function findSubmission(
  spreadsheet: GoogleAppsScript.Spreadsheet.Spreadsheet,
  submissionId: string,
  requestId: string
): QueueLocation | undefined {
  const today = Utilities.formatDate(new Date(), BOSTON_TIME_ZONE, 'yyyy-MM-dd');
  for (const tabName of recentWeekTabNames(today)) {
    const sheet = spreadsheet.getSheetByName(tabName);
    if (!sheet || sheet.getLastRow() < 2) {
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
