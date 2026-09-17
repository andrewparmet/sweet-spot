export const MATCH_TYPES = ['S', 'D'] as const;
export const HANDICAP_ENTRY_TYPES = ['odds', 'difference'] as const;

const ODDS_POINT = '(?:0|15|30|40)';
const ODDS_FRACTION = '(?:h|q)\\s*(?:15|30|40)';
const ODDS_COMPONENT = `(?:${ODDS_POINT}|${ODDS_FRACTION}|-(?:15|30)|-${ODDS_FRACTION})`;
const ODDS_PATTERN = new RegExp(`^${ODDS_COMPONENT}\\s*\\/\\s*${ODDS_COMPONENT}$`, 'i');
const SCORE_PATTERN = /^\d+\s*[-/–—]\s*\d+(?:(?:\s*,\s*|\s+)\d+\s*[-/–—]\s*\d+)*$/;

export type MatchType = (typeof MATCH_TYPES)[number];
export type HandicapEntryType = (typeof HANDICAP_ENTRY_TYPES)[number];

export function isValidOdds(value: string): boolean {
  return ODDS_PATTERN.test(value.trim());
}

export function isValidScore(value: string): boolean {
  return SCORE_PATTERN.test(value.trim());
}

export function normalizeScore(score: string): string {
  return score
    .trim()
    .replace(/[–—]/g, '-')
    .replace(/\s*,\s*/g, ' ')
    .replace(/(\d)\s*-\s*(\d)/g, '$1/$2')
    .replace(/\s+/g, ' ');
}

export interface MatchSubmissionRequest {
  readonly requestId: string;
  readonly clientId: string;
  readonly matchType: MatchType;
  readonly side1Player1: string;
  readonly side1Player2: string;
  readonly side2Player1: string;
  readonly side2Player2: string;
  readonly score: string;
  readonly handicapType: HandicapEntryType;
  readonly handicap: string;
  readonly tournament: boolean;
  readonly website: string;
}

export interface MatchSubmissionResponse {
  readonly submissionId: string;
  readonly accepted: true;
}

export interface UndoSubmissionRequest {
  readonly submissionId: string;
  readonly requestId: string;
}

export interface UndoSubmissionResponse {
  readonly withdrawn: true;
}

export type ValidatedMatchSubmission = Omit<MatchSubmissionRequest, 'website'>;
