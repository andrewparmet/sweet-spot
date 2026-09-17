export function normalizedPlayerName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function playerMatchScore(input: string, candidate: string): number {
  const normalizedInput = normalizedPlayerName(input);
  const normalizedCandidate = normalizedPlayerName(candidate);
  if (normalizedInput === normalizedCandidate) {
    return 0;
  }
  if (normalizedInput.replaceAll(' ', '') === normalizedCandidate.replaceAll(' ', '')) {
    return 0.05;
  }
  const inputParts = normalizedInput.split(' ').filter(Boolean);
  const candidateParts = normalizedCandidate.split(' ').filter(Boolean);
  const inputLast = inputParts.at(-1) || '';
  const candidateLast = candidateParts.at(-1) || '';
  const inputFirst = inputParts[0] || '';
  const candidateFirst = candidateParts[0] || '';
  const surnameMatches = inputLast === candidateLast || (inputLast.length >= 3 && candidateLast.endsWith(inputLast));
  if (inputParts.length > 1 && inputFirst.length === 1 && inputFirst === candidateFirst[0] && surnameMatches) {
    return 0.1;
  }
  if (inputParts.length === 1 && surnameMatches) {
    return 0.15;
  }
  if (inputLast && surnameMatches) {
    if (
      inputFirst &&
      candidateFirst &&
      (inputFirst.startsWith(candidateFirst) || candidateFirst.startsWith(inputFirst))
    ) {
      return 0.25;
    }
    return 0.5 + normalizedDistance(inputFirst, candidateFirst);
  }
  if (normalizedCandidate.includes(normalizedInput) || normalizedInput.includes(normalizedCandidate)) {
    return 1;
  }
  return 2 + normalizedDistance(normalizedInput, normalizedCandidate);
}

function normalizedDistance(left: string, right: string): number {
  const longestLength = Math.max(left.length, right.length);
  return longestLength === 0 ? 0 : editDistance(left, right) / longestLength;
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        (previous[rightIndex] ?? rightIndex) + 1,
        (current[rightIndex - 1] ?? leftIndex) + 1,
        substitution
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? left.length;
}
