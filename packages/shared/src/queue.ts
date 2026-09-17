import type { HandicapEntryType, MatchType } from './match.ts';

export const QUEUE_STATUSES = ['Needs review', 'Needs reconciliation', 'Submitted', 'Failed', 'Withdrawn'] as const;

export type QueueStatus = (typeof QUEUE_STATUSES)[number];

export const INITIAL_QUEUE_STATUS: QueueStatus = 'Needs review';

export const QUEUE_HEADERS = Object.freeze([
  'Submission ID',
  'Request ID',
  'Submitted At',
  'Match Date',
  'Court ID',
  'Match Type',
  'Side 1 Player 1',
  'Side 1 Player 2',
  'Side 2 Player 1',
  'Side 2 Player 2',
  'Score Original',
  'Handicap Entry Type',
  'Handicap Original',
  'Tournament',
  'Status',
  'Score Normalized',
  'RTO Player IDs',
  'RTO Handicap Difference',
  'RTO Match ID',
  'Last Error',
  'Updated At'
]);

export interface QueueRecord {
  readonly submissionId: string;
  readonly requestId: string;
  readonly submittedAt: string;
  readonly matchDate: string;
  readonly courtId: number;
  readonly matchType: MatchType;
  readonly side1Player1: string;
  readonly side1Player2: string;
  readonly side2Player1: string;
  readonly side2Player2: string;
  readonly scoreOriginal: string;
  readonly handicapEntryType: HandicapEntryType;
  readonly handicapOriginal: string;
  readonly tournament: boolean;
  readonly status: QueueStatus;
  readonly scoreNormalized: string;
  readonly rtoPlayerIds: string;
  readonly rtoHandicapDifference: string;
  readonly rtoMatchId: string;
  readonly lastError: string;
  readonly updatedAt: string;
}

export function queueRecordToRow(record: QueueRecord): (string | number | boolean)[] {
  return [
    record.submissionId,
    record.requestId,
    record.submittedAt,
    record.matchDate,
    record.courtId,
    record.matchType,
    record.side1Player1,
    record.side1Player2,
    record.side2Player1,
    record.side2Player2,
    record.scoreOriginal,
    record.handicapEntryType,
    record.handicapOriginal,
    record.tournament,
    record.status,
    record.scoreNormalized,
    record.rtoPlayerIds,
    record.rtoHandicapDifference,
    record.rtoMatchId,
    record.lastError,
    record.updatedAt
  ];
}

export interface QueueLocation {
  readonly tabName: string;
  readonly rowNumber: number;
}
