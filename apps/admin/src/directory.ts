import type { MatchType } from '../../../packages/shared/src/match.ts';
import { loadBostonDirectory, loadPlayerDirectory, type DirectoryPlayer } from './api.ts';
import { normalizedPlayerName } from './player-search.ts';

const DIRECTORY_CACHE_PREFIX = 'sweet-spot-rto-directory-v7';
const directoryLoads = new Map<MatchType, Promise<DirectoryPlayer[]>>();

export async function loadBostonPlayers(matchType: MatchType): Promise<DirectoryPlayer[]> {
  const cacheKey = `${DIRECTORY_CACHE_PREFIX}:boston:${matchType}`;
  const cached = cachedPlayers(cacheKey);
  if (cached) {
    return cached;
  }
  const existingLoad = directoryLoads.get(matchType);
  if (existingLoad) {
    return existingLoad;
  }
  const load = (async () => {
    const players = await loadBostonDirectory(matchType);
    sessionStorage.setItem(cacheKey, JSON.stringify(players));
    return players;
  })();
  directoryLoads.set(matchType, load);
  try {
    return await load;
  } finally {
    directoryLoads.delete(matchType);
  }
}

export async function expandPlayerSearch(matchType: MatchType, playerName: string): Promise<DirectoryPlayer[]> {
  const cacheKey = `${DIRECTORY_CACHE_PREFIX}:expanded:${matchType}:${normalizedPlayerName(playerName)}`;
  const cached = cachedPlayers(cacheKey);
  if (cached) {
    return cached;
  }
  const players = await loadPlayerDirectory(matchType, playerName);
  sessionStorage.setItem(cacheKey, JSON.stringify(players));
  return players;
}

export function preloadBostonPlayers(): void {
  void Promise.allSettled([loadBostonPlayers('S'), loadBostonPlayers('D')]);
}

export function clearDirectoryCache(): void {
  for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
    const key = sessionStorage.key(index);
    if (key?.startsWith(DIRECTORY_CACHE_PREFIX)) {
      sessionStorage.removeItem(key);
    }
  }
  directoryLoads.clear();
}

function cachedPlayers(key: string): DirectoryPlayer[] | undefined {
  const serialized = sessionStorage.getItem(key);
  if (!serialized) {
    return undefined;
  }
  try {
    return JSON.parse(serialized) as DirectoryPlayer[];
  } catch {
    sessionStorage.removeItem(key);
    return undefined;
  }
}
