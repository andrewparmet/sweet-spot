interface OddsReferenceRow {
  readonly hcapDifference?: unknown;
  readonly HcapDifference?: unknown;
  readonly oddsShort1?: unknown;
  readonly OddsShort1?: unknown;
  readonly oddsShort2?: unknown;
  readonly OddsShort2?: unknown;
}

export function resolvePlayedHandicapDifference(
  odds: string,
  rows: readonly OddsReferenceRow[],
  suggestedDifference: number
): number {
  const [teamOne, teamTwo] = odds.split('/').map(normalizeEnteredOddsComponent);
  if (!teamOne || !teamTwo) {
    throw new Error('The entered odds could not be interpreted.');
  }
  const candidates: number[] = [];
  for (const row of rows) {
    const difference = Number(row.hcapDifference ?? row.HcapDifference);
    if (!Number.isFinite(difference)) {
      continue;
    }
    const rowTeamOne = normalizeRtoOdds(row.oddsShort1 ?? row.OddsShort1);
    const rowTeamTwo = normalizeRtoOdds(row.oddsShort2 ?? row.OddsShort2);
    if (teamOne === rowTeamOne && teamTwo === rowTeamTwo) {
      candidates.push(difference);
    }
    if (teamOne === rowTeamTwo && teamTwo === rowTeamOne && difference !== 0) {
      candidates.push(-difference);
    }
  }
  if (candidates.length === 0) {
    throw new Error('Those odds do not match an RTO handicap difference. Enter the difference instead.');
  }
  return candidates.reduce((best, candidate) =>
    Math.abs(candidate - suggestedDifference) < Math.abs(best - suggestedDifference) ? candidate : best
  );
}

function normalizeEnteredOddsComponent(value: string): string {
  const component = value.trim().toLowerCase().replace(/\s+/g, '');
  if (component === '0') {
    return 'love';
  }
  const direction = component.startsWith('-') ? 'owe' : 'rec';
  return `${direction}:${component.replace(/^[+-]/, '')}`;
}

function normalizeRtoOdds(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll('¼', 'q')
    .replaceAll('½', 'h')
    .replace(/[\s-]+/g, '');
  if (normalized === 'love' || normalized === '0') {
    return 'love';
  }
  if (normalized.startsWith('owe')) {
    return `owe:${normalized.slice(3)}`;
  }
  if (normalized.startsWith('rec')) {
    return `rec:${normalized.replace(/^receive|^receives|^rec/, '')}`;
  }
  return normalized;
}
