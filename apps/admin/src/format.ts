import type { QueueRecord } from '../../../packages/shared/src/queue.ts';

export function teamName(record: QueueRecord, side: 1 | 2): string {
  const players = side === 1 ? [record.side1Player1, record.side1Player2] : [record.side2Player1, record.side2Player2];
  return players.filter(Boolean).join(' / ');
}

export function playerSides(record: QueueRecord): string[][] {
  return [
    [record.side1Player1, record.side1Player2].filter(Boolean),
    [record.side2Player1, record.side2Player2].filter(Boolean)
  ];
}

export function handicapLabel(record: QueueRecord): string {
  if (!record.handicapOriginal) {
    return 'Handicap';
  }
  return record.handicapEntryType === 'difference' ? 'Difference' : 'Odds';
}

export function matchCategory(record: QueueRecord): string {
  if (record.sanctioned) {
    return 'Sanctioned tournament';
  }
  return record.tournament ? 'Tournament' : 'Friendly';
}

export function statusClass(status: QueueRecord['status']): string {
  return `status status-${status.toLowerCase().replaceAll(' ', '-')}`;
}

export function isReviewable(record: QueueRecord): boolean {
  return (
    record.status !== 'Submitted' &&
    record.status !== 'Withdrawn' &&
    (record.status !== 'Needs reconciliation' || wasRejectedByRto(record))
  );
}

/**
 * Whether a `Needs reconciliation` record recorded an RTO 4xx rejection, which means RTO saved nothing.
 */
export function wasRejectedByRto(record: QueueRecord): boolean {
  return (
    record.status === 'Needs reconciliation' &&
    /^RTO returned HTTP 4(?!08)\d\d without a readable match ID\./.test(record.lastError)
  );
}

export function rtoMatchUrl(rtoMatchId: string): string | undefined {
  const numericMatchId = Number(rtoMatchId);
  if (Number.isSafeInteger(numericMatchId) && numericMatchId > 0 && String(numericMatchId) === rtoMatchId) {
    return 'https://www.realtennisonline.com/v2/matches/details/' + rtoMatchId;
  }
  return undefined;
}

export function formatMatchDate(matchDate: string): string {
  const [year, month, day] = matchDate.split('-').map(Number);
  if (!year || !month || !day) {
    return matchDate;
  }
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  }).format(new Date(year, month - 1, day));
}

export function formatEntryTimestamp(submittedAt: string): string | undefined {
  const timestamp = new Date(submittedAt);
  if (Number.isNaN(timestamp.getTime())) {
    return undefined;
  }
  return `Entered ${new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(timestamp)}`;
}

export function formatHistoryWeek(weekId: string): string {
  const match = /^(\d{4})-W(\d{2})$/.exec(weekId);
  if (!match) {
    return '';
  }
  const year = Number(match[1]);
  const week = Number(match[2]);
  const januaryFourth = new Date(Date.UTC(year, 0, 4));
  const januaryFourthDay = januaryFourth.getUTCDay() || 7;
  const start = new Date(januaryFourth);
  start.setUTCDate(januaryFourth.getUTCDate() - januaryFourthDay + 1 + (week - 1) * 7);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC'
  }).formatRange(start, end);
}
