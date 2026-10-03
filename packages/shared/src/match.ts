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
  return !scoreError(value);
}

/**
 * Describes why `value` is not a score RTO accepts, or returns undefined for a valid score.
 *
 * A score has up to five sets. Every set but the last must be finished: untied, with one side reaching the first set's
 * winning game count.
 */
export function scoreError(value: string): string | undefined {
  if (!SCORE_PATTERN.test(value.trim())) {
    return 'Enter game scores like 6-2,6-1 or 10-8.';
  }
  const sets = normalizeScore(value)
    .split(' ')
    .map(set => set.split('/').map(Number));
  if (sets.length > 5) {
    return 'Enter at most five sets.';
  }
  if (sets.some(([side1, side2]) => side1 === 0 && side2 === 0)) {
    return 'Remove the 0-0 set.';
  }
  const setLength = Math.max(...(sets[0] ?? []));
  const unfinished = sets
    .slice(0, -1)
    .some(([side1, side2]) => side1 === side2 || (side1 !== setLength && side2 !== setLength));
  return unfinished ? 'Only the last set can be unfinished.' : undefined;
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
