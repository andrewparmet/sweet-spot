import type { QueueRecord } from '../packages/shared/src/queue.ts';
import { writeLocalTab } from './local-queue.ts';

interface SampleOverrides extends Partial<QueueRecord> {
  readonly submissionId: string;
  readonly requestId: string;
  readonly submittedAt: string;
  readonly matchDate: string;
  readonly updatedAt: string;
}

function sample(overrides: SampleOverrides): QueueRecord {
  return {
    courtId: 36,
    matchType: 'S',
    side1Player1: 'Charlie Brown',
    side1Player2: '',
    side2Player1: 'Lucy van Pelt',
    side2Player2: '',
    scoreOriginal: '6-2, 6-1',
    handicapEntryType: 'odds',
    handicapOriginal: '-15/15',
    tournament: false,
    status: 'Needs review',
    scoreNormalized: '6/2 6/1',
    rtoPlayerIds: '',
    rtoHandicapDifference: '',
    rtoMatchId: '',
    lastError: '',
    ...overrides
  };
}

const week37: QueueRecord[] = [
  sample({
    submissionId: 'sample-submission-001',
    requestId: 'sample-request-001',
    submittedAt: '2026-09-10T18:12:00-04:00',
    matchDate: '2026-09-10',
    status: 'Submitted',
    rtoPlayerIds: '10001,10002',
    rtoHandicapDifference: '-16',
    rtoMatchId: '987654',
    updatedAt: '2026-09-10T18:18:00-04:00'
  }),
  sample({
    submissionId: 'sample-submission-002',
    requestId: 'sample-request-002',
    submittedAt: '2026-09-12T14:25:00-04:00',
    matchDate: '2026-09-12',
    matchType: 'D',
    side1Player1: 'Peppermint Patty',
    side1Player2: 'Marcie',
    side2Player1: 'Linus van Pelt',
    side2Player2: 'Sally Brown',
    scoreOriginal: '6-4, 3-6, 6-5',
    scoreNormalized: '6/4 3/6 6/5',
    handicapEntryType: 'difference',
    handicapOriginal: '8',
    status: 'Failed',
    lastError: 'One player needs an RTO match.',
    updatedAt: '2026-09-12T14:31:00-04:00'
  })
];

const week38: QueueRecord[] = [
  sample({
    submissionId: 'sample-submission-003',
    requestId: 'sample-request-003',
    submittedAt: '2026-09-17T08:05:00-04:00',
    matchDate: '2026-09-17',
    updatedAt: '2026-09-17T08:05:00-04:00'
  }),
  sample({
    submissionId: 'sample-submission-004',
    requestId: 'sample-request-004',
    submittedAt: '2026-09-17T08:15:00-04:00',
    matchDate: '2026-09-17',
    matchType: 'D',
    side1Player1: 'Snoopy',
    side1Player2: 'Woodstock',
    side2Player1: 'Schroeder',
    side2Player2: 'Franklin Armstrong',
    scoreOriginal: '10-8',
    scoreNormalized: '10/8',
    handicapEntryType: 'difference',
    handicapOriginal: '-4',
    tournament: true,
    status: 'Ready',
    rtoPlayerIds: '10003,10004,10005,10006',
    rtoHandicapDifference: '-4',
    updatedAt: '2026-09-17T08:22:00-04:00'
  }),
  sample({
    submissionId: 'sample-submission-005',
    requestId: 'sample-request-005',
    submittedAt: '2026-09-17T08:30:00-04:00',
    matchDate: '2026-09-17',
    side1Player1: 'C Brown',
    side2Player1: 'L van Pelt',
    scoreOriginal: '4-3',
    scoreNormalized: '4/3',
    handicapOriginal: '15/0',
    status: 'Needs review',
    rtoPlayerIds: '10001,10002',
    rtoHandicapDifference: '15',
    updatedAt: '2026-09-17T08:31:00-04:00'
  }),
  sample({
    submissionId: 'sample-submission-006',
    requestId: 'sample-request-006',
    submittedAt: '2026-09-17T08:40:00-04:00',
    matchDate: '2026-09-17',
    side1Player1: 'Pig-Pen',
    side2Player1: 'Violet Gray',
    scoreOriginal: '6-5, 2-1 unfinished',
    scoreNormalized: '6/5 2/1 unfinished',
    handicapOriginal: '-h15/15',
    status: 'Withdrawn',
    updatedAt: '2026-09-17T08:43:00-04:00'
  })
];

await Promise.all([writeLocalTab('2026-W37', week37), writeLocalTab('2026-W38', week38)]);
console.log('Seeded 6 local submissions across 2026-W37 and 2026-W38.');
