import { normalizeScore } from './match.ts';
import { INITIAL_QUEUE_STATUS, QUEUE_HEADERS, type QueueRecord } from './queue.ts';
import type { MatchFields } from './submission.ts';

export const BOSTON_COURT_ID = 36;
export const WEEK_SHEET_NAME_PATTERN = /^\d{4}-W\d{2}$/;

export interface NewQueueRecord {
  readonly submissionId: string;
  readonly requestId: string;
  readonly timestamp: string;
  readonly matchDate: string;
  readonly sanctioned: boolean;
}

export function newQueueRecord(fields: MatchFields, entry: NewQueueRecord): QueueRecord {
  return {
    submissionId: entry.submissionId,
    requestId: entry.requestId,
    submittedAt: entry.timestamp,
    matchDate: entry.matchDate,
    courtId: BOSTON_COURT_ID,
    matchType: fields.matchType,
    side1Player1: escapeForSheet(fields.side1Player1),
    side1Player2: escapeForSheet(fields.side1Player2),
    side2Player1: escapeForSheet(fields.side2Player1),
    side2Player2: escapeForSheet(fields.side2Player2),
    scoreOriginal: escapeForSheet(fields.score),
    handicapEntryType: fields.handicapType,
    handicapOriginal: escapeForSheet(fields.handicap),
    tournament: fields.tournament || entry.sanctioned,
    status: INITIAL_QUEUE_STATUS,
    scoreNormalized: escapeForSheet(normalizeScore(fields.score)),
    rtoPlayerIds: '',
    rtoHandicapDifference: '',
    rtoMatchId: '',
    lastError: '',
    updatedAt: entry.timestamp,
    sanctioned: entry.sanctioned
  };
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

export function ensureWeekSheet(
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

  sheet.getRange(1, 1, sheet.getMaxRows(), QUEUE_HEADERS.length).setNumberFormat('@');
  if (sheet.getLastRow() === 0) {
    sheet.appendRow([...QUEUE_HEADERS]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, QUEUE_HEADERS.length).setFontWeight('bold');
  } else if (sheet.getLastColumn() < QUEUE_HEADERS.length) {
    sheet
      .getRange(1, 1, 1, QUEUE_HEADERS.length)
      .setValues([[...QUEUE_HEADERS]])
      .setFontWeight('bold');
  }
  return sheet;
}

export function findSubmissionByRequestId(
  spreadsheet: GoogleAppsScript.Spreadsheet.Spreadsheet,
  requestId: string
): string {
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

function sheetIsEmpty(sheet: GoogleAppsScript.Spreadsheet.Sheet): boolean {
  return (
    sheet.getLastRow() === 0 ||
    (sheet.getLastRow() === 1 && sheet.getLastColumn() === 1 && !sheet.getRange(1, 1).getValue())
  );
}
