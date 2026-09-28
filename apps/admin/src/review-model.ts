import { computed, signal } from '@preact/signals';
import { isValidScore, type MatchType } from '../../../packages/shared/src/match.ts';
import type { AdminQueueItem, DirectoryPlayer, ReviewedMatchRequest } from './api.ts';
import { playerSides } from './format.ts';
import { playerMatchScore, reasonablePlayerMatches } from './player-search.ts';

export type ExpansionStatus = 'idle' | 'expanding' | 'expanded';

export interface PlayerSlot {
  readonly side: number;
  readonly originalName: string;
  readonly rankingName: string;
  readonly expanded: readonly DirectoryPlayer[];
  readonly selectedId: string;
  readonly expansion: ExpansionStatus;
  readonly manualOpen: boolean;
  readonly manualQuery: string;
  readonly manualSearching: boolean;
}

export interface ReviewForm {
  readonly phase: 'editing' | 'submitting';
  readonly item: AdminQueueItem;
  readonly boston: readonly DirectoryPlayer[];
  readonly score: string;
  readonly slots: readonly PlayerSlot[];
  readonly error: string | undefined;
}

export type ReviewState =
  | { readonly phase: 'closed' }
  | { readonly phase: 'loading'; readonly item: AdminQueueItem }
  | { readonly phase: 'failed'; readonly item: AdminQueueItem; readonly error: string }
  | ReviewForm;

export interface PlayerOptions {
  readonly boston: readonly DirectoryPlayer[];
  readonly wider: readonly DirectoryPlayer[];
  readonly bestMatchId: string | undefined;
}

export interface ReviewDependencies {
  readonly loadBostonPlayers: (matchType: MatchType) => Promise<DirectoryPlayer[]>;
  readonly expandPlayerSearch: (matchType: MatchType, playerName: string) => Promise<DirectoryPlayer[]>;
  readonly submitReviewedMatch: (request: ReviewedMatchRequest) => Promise<void>;
  readonly onSubmitted: () => void;
}

export type ReviewModel = ReturnType<typeof createReviewModel>;

export function createReviewModel(dependencies: ReviewDependencies) {
  const state = signal<ReviewState>({ phase: 'closed' });
  const canSubmit = computed(() => {
    const current = state.value;
    return (
      current.phase === 'editing' &&
      isValidScore(current.score) &&
      current.slots.length > 0 &&
      current.slots.every(slot => slot.selectedId)
    );
  });

  function currentForm(): ReviewForm | undefined {
    const current = state.value;
    return current.phase === 'editing' || current.phase === 'submitting' ? current : undefined;
  }

  function updateForm(item: AdminQueueItem, update: (form: ReviewForm) => Partial<ReviewForm>): void {
    const form = currentForm();
    if (form?.item === item) {
      state.value = { ...form, ...update(form) };
    }
  }

  function updateSlot(item: AdminQueueItem, index: number, update: (slot: PlayerSlot) => Partial<PlayerSlot>): void {
    updateForm(item, form => ({
      slots: form.slots.map((slot, slotIndex) => (slotIndex === index ? { ...slot, ...update(slot) } : slot))
    }));
  }

  async function open(item: AdminQueueItem): Promise<void> {
    state.value = { phase: 'loading', item };
    try {
      const boston = await dependencies.loadBostonPlayers(item.record.matchType);
      if (state.value.phase !== 'loading' || state.value.item !== item) {
        return;
      }
      const slots = playerSides(item.record).flatMap((names, sideIndex) =>
        names.map(name => newSlot(sideIndex + 1, name, boston))
      );
      state.value = { phase: 'editing', item, boston, score: item.record.scoreOriginal, slots, error: undefined };
    } catch (error) {
      if (state.value.phase === 'loading' && state.value.item === item) {
        state.value = { phase: 'failed', item, error: errorMessage(error, 'The directory could not be loaded.') };
      }
    }
  }

  function close(): void {
    if (state.value.phase !== 'submitting') {
      state.value = { phase: 'closed' };
    }
  }

  function reset(): void {
    state.value = { phase: 'closed' };
  }

  function setScore(score: string): void {
    const form = currentForm();
    if (form) {
      updateForm(form.item, () => ({ score }));
    }
  }

  function selectPlayer(index: number, selectedId: string): void {
    const form = currentForm();
    if (form) {
      updateSlot(form.item, index, () => ({ selectedId }));
    }
  }

  function toggleManualSearch(index: number): void {
    const form = currentForm();
    if (form) {
      updateSlot(form.item, index, slot => ({ manualOpen: !slot.manualOpen }));
    }
  }

  function setManualQuery(index: number, manualQuery: string): void {
    const form = currentForm();
    if (form) {
      updateSlot(form.item, index, () => ({ manualQuery }));
    }
  }

  async function addExpandedPlayers(form: ReviewForm, index: number, query: string): Promise<void> {
    const players = await dependencies.expandPlayerSearch(form.item.record.matchType, query);
    updateSlot(form.item, index, slot => {
      const expanded = mergePlayers(players, slot.expanded);
      return {
        expanded,
        rankingName: query,
        selectedId: playerOptions(query, form.boston, expanded).bestMatchId ?? ''
      };
    });
  }

  async function expand(index: number): Promise<void> {
    const form = currentForm();
    const slot = form?.slots[index];
    if (!form || !slot) {
      return;
    }
    updateForm(form.item, () => ({ error: undefined }));
    updateSlot(form.item, index, () => ({ expansion: 'expanding' }));
    try {
      await addExpandedPlayers(form, index, slot.originalName);
      updateSlot(form.item, index, () => ({ expansion: 'expanded' }));
    } catch (error) {
      updateSlot(form.item, index, () => ({ expansion: 'idle' }));
      updateForm(form.item, () => ({ error: errorMessage(error, 'The wider directory could not be searched.') }));
    }
  }

  async function searchManually(index: number): Promise<void> {
    const form = currentForm();
    const slot = form?.slots[index];
    if (!form || !slot) {
      return;
    }
    const query = slot.manualQuery.trim();
    if (!query) {
      updateForm(form.item, () => ({ error: 'Enter a player name to search.' }));
      return;
    }
    updateForm(form.item, () => ({ error: undefined }));
    updateSlot(form.item, index, () => ({ manualSearching: true }));
    try {
      await addExpandedPlayers(form, index, query);
    } catch (error) {
      updateForm(form.item, () => ({ error: errorMessage(error, 'The wider directory could not be searched.') }));
    } finally {
      updateSlot(form.item, index, () => ({ manualSearching: false }));
    }
  }

  async function submit(): Promise<void> {
    const form = currentForm();
    if (!form || !canSubmit.value) {
      return;
    }
    const players = form.slots.map(slot => {
      const player = mergePlayers(form.boston, slot.expanded).find(candidate => candidate.id === slot.selectedId);
      return { id: slot.selectedId, handicap: player?.handicap ?? Number.NaN };
    });
    if (players.some(player => !Number.isFinite(player.handicap))) {
      updateForm(form.item, () => ({ error: 'Match every entered player before submitting.' }));
      return;
    }
    updateForm(form.item, () => ({ phase: 'submitting', error: undefined }));
    try {
      await dependencies.submitReviewedMatch({
        submissionId: form.item.record.submissionId,
        players,
        score: form.score.trim()
      });
      if (currentForm()?.item === form.item) {
        state.value = { phase: 'closed' };
      }
      dependencies.onSubmitted();
    } catch (error) {
      updateForm(form.item, () => ({ phase: 'editing', error: errorMessage(error, 'The submission failed.') }));
    }
  }

  return {
    state,
    canSubmit,
    open,
    close,
    reset,
    setScore,
    selectPlayer,
    toggleManualSearch,
    setManualQuery,
    expand,
    searchManually,
    submit
  };
}

export function playerOptions(
  name: string,
  bostonDirectory: readonly DirectoryPlayer[],
  expandedDirectory: readonly DirectoryPlayer[]
): PlayerOptions {
  const directory = mergePlayers(bostonDirectory, expandedDirectory);
  const boston = reasonablePlayerMatches(
    name,
    directory.filter(player => player.isBoston)
  );
  const wider = reasonablePlayerMatches(
    name,
    directory.filter(player => !player.isBoston)
  );
  const bestMatchId = [...boston, ...wider].reduce<DirectoryPlayer | undefined>((best, player) => {
    if (!best || playerMatchScore(name, player.name) < playerMatchScore(name, best.name)) {
      return player;
    }
    return best;
  }, undefined)?.id;
  return { boston, wider, bestMatchId };
}

export function mergePlayers(...directories: readonly (readonly DirectoryPlayer[])[]): DirectoryPlayer[] {
  const playersById = new Map<string, DirectoryPlayer>();
  for (const directory of directories) {
    for (const player of directory) {
      playersById.set(player.id, player);
    }
  }
  return [...playersById.values()];
}

function newSlot(side: number, originalName: string, boston: readonly DirectoryPlayer[]): PlayerSlot {
  return {
    side,
    originalName,
    rankingName: originalName,
    expanded: [],
    selectedId: playerOptions(originalName, boston, []).bestMatchId ?? '',
    expansion: 'idle',
    manualOpen: false,
    manualQuery: originalName,
    manualSearching: false
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
