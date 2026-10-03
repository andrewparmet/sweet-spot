import {
  HANDICAP_ENTRY_TYPES,
  isValidOdds,
  scoreError,
  MATCH_TYPES,
  type HandicapEntryType,
  type MatchType
} from './match.ts';

const MAX_TEXT_LENGTH = 100;
const MAX_SCORE_LENGTH = 100;
const MAX_HANDICAP_LENGTH = 60;
const MAX_MATCH_AGE_DAYS = 90;

export interface MatchFields {
  readonly matchType: MatchType;
  readonly side1Player1: string;
  readonly side1Player2: string;
  readonly side2Player1: string;
  readonly side2Player2: string;
  readonly score: string;
  readonly handicapType: HandicapEntryType;
  readonly handicap: string;
  readonly tournament: boolean;
}

export function validateMatchFields(payload: Record<string, unknown>): MatchFields {
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
  const invalidScore = scoreError(score);
  if (invalidScore) {
    throw new Error(invalidScore);
  }
  const handicap = optionalText(payload.handicap, 'Handicap played', MAX_HANDICAP_LENGTH);
  if (handicap && handicapType === 'difference' && !/^[+-]?\d+(?:\.\d+)?$/.test(handicap)) {
    throw new Error('Enter the handicap difference as a number.');
  }
  if (handicap && handicapType === 'odds' && !isValidOdds(handicap)) {
    throw new Error('Enter two valid odds scores, such as -15/15 or -h15/15.');
  }

  return {
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

/**
 * Validates a `yyyy-MM-dd` match date that is no later than `today` and at most 90 days earlier.
 */
export function validateMatchDate(value: unknown, today: string): string {
  const matchDate = String(value ?? '').trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(matchDate) ? new Date(`${matchDate}T00:00:00Z`) : undefined;
  if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== matchDate) {
    throw new Error('Enter a valid match date.');
  }
  if (matchDate > today) {
    throw new Error('The match date cannot be in the future.');
  }
  const earliest = new Date(`${today}T00:00:00Z`);
  earliest.setUTCDate(earliest.getUTCDate() - MAX_MATCH_AGE_DAYS);
  if (date < earliest) {
    throw new Error(`The match date must be within the last ${MAX_MATCH_AGE_DAYS} days.`);
  }
  return matchDate;
}

export function requiredText(value: unknown, label: string, maxLength: number): string {
  const text = optionalText(value, label, maxLength);
  if (!text) {
    throw new Error(`${label} is required.`);
  }
  return text;
}

export function optionalText(value: unknown, label: string, maxLength: number): string {
  const text = String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  if (text.length > maxLength) {
    throw new Error(`${label} is too long.`);
  }
  return text;
}

function isIncluded<const T extends readonly string[]>(values: T, value: string): value is T[number] {
  return values.includes(value as T[number]);
}
