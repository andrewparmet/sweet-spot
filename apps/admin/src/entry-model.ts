import { signal } from '@preact/signals';
import { isValidOdds, scoreError, type MatchType } from '../../../packages/shared/src/match.ts';
import type { AdminEntryRequest } from './api.ts';

export interface EntryDraft {
  readonly matchType: MatchType;
  readonly matchDate: string;
  readonly side1Player1: string;
  readonly side1Player2: string;
  readonly side2Player1: string;
  readonly side2Player2: string;
  readonly score: string;
  readonly handicap: string;
  readonly tournament: boolean;
  readonly sanctioned: boolean;
  readonly requestId: string;
}

export type EntryFieldName =
  'matchDate' | 'side1Player1' | 'side1Player2' | 'side2Player1' | 'side2Player2' | 'score' | 'handicap';

export interface EntryFieldError {
  readonly field: EntryFieldName;
  readonly message: string;
}

export interface EntryState {
  readonly draft: EntryDraft;
  readonly submitting: boolean;
  readonly message: { readonly kind: 'error' | 'notice'; readonly text: string } | undefined;
  readonly fieldError: EntryFieldError | undefined;
}

export interface EntryDependencies {
  readonly randomId: () => string;
  readonly today: () => string;
  readonly submitAdminEntry: (request: AdminEntryRequest) => Promise<void>;
}

export type EntryModel = ReturnType<typeof createEntryModel>;

const REQUIRED_FIELD_MESSAGES: Record<Exclude<EntryFieldName, 'handicap'>, string> = {
  matchDate: 'Enter the match date.',
  side1Player1: 'Enter the Side 1 player.',
  side1Player2: 'Enter the Side 1 partner.',
  side2Player1: 'Enter the Side 2 player.',
  side2Player2: 'Enter the Side 2 partner.',
  score: 'Enter the result.'
};

export function createEntryModel(dependencies: EntryDependencies) {
  const state = signal<EntryState>({
    draft: {
      matchType: 'S',
      matchDate: dependencies.today(),
      side1Player1: '',
      side1Player2: '',
      side2Player1: '',
      side2Player2: '',
      score: '',
      handicap: '',
      tournament: false,
      sanctioned: false,
      requestId: dependencies.randomId()
    },
    submitting: false,
    message: undefined,
    fieldError: undefined
  });

  function updateDraft(patch: Partial<EntryDraft>): void {
    state.value = { ...state.value, draft: { ...state.value.draft, ...patch }, fieldError: undefined };
  }

  function setTournament(tournament: boolean): void {
    updateDraft(tournament ? { tournament } : { tournament, sanctioned: false });
  }

  function setSanctioned(sanctioned: boolean): void {
    updateDraft(sanctioned ? { sanctioned, tournament: true } : { sanctioned });
  }

  async function submit(): Promise<'invalid' | 'failed' | 'submitted' | undefined> {
    const { draft, submitting } = state.value;
    if (submitting) {
      return undefined;
    }
    const fieldError = firstInvalidEntryField(draft, dependencies.today());
    state.value = { ...state.value, message: undefined, fieldError };
    if (fieldError) {
      return 'invalid';
    }
    state.value = { ...state.value, submitting: true };
    try {
      await dependencies.submitAdminEntry({ ...draft, handicapType: 'odds' });
      state.value = {
        draft: {
          ...draft,
          side1Player1: '',
          side1Player2: '',
          side2Player1: '',
          side2Player2: '',
          score: '',
          handicap: '',
          requestId: dependencies.randomId()
        },
        submitting: false,
        message: { kind: 'notice', text: `Added ${matchup(draft)} to Needs review.` },
        fieldError: undefined
      };
      return 'submitted';
    } catch (error) {
      state.value = {
        ...state.value,
        submitting: false,
        message: {
          kind: 'error',
          text: error instanceof Error && error.message ? error.message : 'The score could not be added.'
        }
      };
      return 'failed';
    }
  }

  return { state, today: dependencies.today, updateDraft, setTournament, setSanctioned, submit };
}

export function firstInvalidEntryField(draft: EntryDraft, today: string): EntryFieldError | undefined {
  const requiredFields: (keyof typeof REQUIRED_FIELD_MESSAGES)[] =
    draft.matchType === 'D'
      ? ['matchDate', 'side1Player1', 'side1Player2', 'side2Player1', 'side2Player2', 'score']
      : ['matchDate', 'side1Player1', 'side2Player1', 'score'];
  const missingField = requiredFields.find(field => !draft[field].trim());
  if (missingField) {
    return { field: missingField, message: REQUIRED_FIELD_MESSAGES[missingField] };
  }
  if (draft.matchDate > today) {
    return { field: 'matchDate', message: 'The match date cannot be in the future.' };
  }
  const invalidScore = scoreError(draft.score);
  if (invalidScore) {
    return { field: 'score', message: invalidScore };
  }
  if (draft.handicap.trim() && !isValidOdds(draft.handicap)) {
    return { field: 'handicap', message: 'Enter two valid odds scores, such as -15/15 or -h15/15.' };
  }
  return undefined;
}

function matchup(draft: EntryDraft): string {
  const side = (player: string, partner: string) =>
    draft.matchType === 'D' ? `${player.trim()} / ${partner.trim()}` : player.trim();
  return `${side(draft.side1Player1, draft.side1Player2)} vs ${side(draft.side2Player1, draft.side2Player2)}`;
}
