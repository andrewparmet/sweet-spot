import { signal } from '@preact/signals';
import {
  isValidOdds,
  scoreError,
  MATCH_TYPES,
  type MatchSubmissionRequest,
  type MatchSubmissionResponse,
  type MatchType,
  type UndoSubmissionRequest,
  type UndoSubmissionResponse
} from '../../../packages/shared/src/match.ts';

export const DRAFT_KEY = 'sweet-spot-draft-v1';
const CLIENT_ID_KEY = 'sweet-spot-client-id-v1';

export interface Draft {
  readonly matchType: MatchType;
  readonly side1Player1: string;
  readonly side1Player2: string;
  readonly side2Player1: string;
  readonly side2Player2: string;
  readonly score: string;
  readonly handicap: string;
  readonly tournament: boolean;
  readonly requestId: string;
}

export type TextFieldName = 'side1Player1' | 'side1Player2' | 'side2Player1' | 'side2Player2' | 'score' | 'handicap';

export interface FieldError {
  readonly field: TextFieldName;
  readonly message: string;
}

export interface FormMessage {
  readonly kind: 'error' | 'notice';
  readonly text: string;
}

export type Submission =
  | { readonly phase: 'editing' }
  | { readonly phase: 'submitting'; readonly draft: Draft }
  | { readonly phase: 'submitted' | 'undoing'; readonly draft: Draft; readonly receipt: UndoSubmissionRequest };

export interface MatchEntryState {
  readonly draft: Draft;
  readonly website: string;
  readonly submission: Submission;
  readonly message: FormMessage | undefined;
  readonly fieldError: FieldError | undefined;
}

export interface MatchEntryDependencies {
  readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  readonly randomId: () => string;
  readonly submitMatch: (payload: MatchSubmissionRequest) => Promise<MatchSubmissionResponse>;
  readonly undoSubmission: (payload: UndoSubmissionRequest) => Promise<UndoSubmissionResponse>;
}

export type MatchEntryModel = ReturnType<typeof createMatchEntryModel>;

const REQUIRED_FIELD_MESSAGES: Record<Exclude<TextFieldName, 'handicap'>, string> = {
  side1Player1: 'Enter the Side 1 player.',
  side1Player2: 'Enter the Side 1 partner.',
  side2Player1: 'Enter the Side 2 player.',
  side2Player2: 'Enter the Side 2 partner.',
  score: 'Enter the result.'
};

export function createMatchEntryModel(dependencies: MatchEntryDependencies) {
  const state = signal<MatchEntryState>({
    draft: restoreDraft(dependencies),
    website: '',
    submission: { phase: 'editing' },
    message: undefined,
    fieldError: undefined
  });

  function update(patch: Partial<MatchEntryState>): void {
    state.value = { ...state.value, ...patch };
  }

  function saveDraft(draft: Draft): void {
    dependencies.storage.setItem(DRAFT_KEY, JSON.stringify(draft));
  }

  function updateDraft(patch: Partial<Draft>): void {
    const draft = { ...state.value.draft, ...patch };
    update({ draft, fieldError: undefined });
    saveDraft(draft);
  }

  function setWebsite(website: string): void {
    update({ website });
  }

  async function submit(): Promise<'invalid' | 'failed' | 'submitted' | undefined> {
    const { draft, website, submission } = state.value;
    if (submission.phase !== 'editing') {
      return undefined;
    }
    const fieldError = firstInvalidField(draft);
    update({ message: undefined, fieldError });
    if (fieldError) {
      return 'invalid';
    }
    update({ submission: { phase: 'submitting', draft } });
    try {
      const result = await dependencies.submitMatch({
        ...draft,
        handicapType: 'odds',
        website,
        clientId: clientId(dependencies)
      });
      update({
        submission: {
          phase: 'submitted',
          draft,
          receipt: { submissionId: result.submissionId, requestId: draft.requestId }
        }
      });
      dependencies.storage.removeItem(DRAFT_KEY);
      return 'submitted';
    } catch (error) {
      update({
        submission: { phase: 'editing' },
        message: { kind: 'error', text: errorMessage(error, 'The score could not be submitted. Try again.') }
      });
      return 'failed';
    }
  }

  async function undo(): Promise<'failed' | 'undone' | undefined> {
    const { submission } = state.value;
    if (submission.phase !== 'submitted') {
      return undefined;
    }
    update({ message: undefined, submission: { ...submission, phase: 'undoing' } });
    try {
      await dependencies.undoSubmission(submission.receipt);
      const draft = { ...submission.draft, requestId: dependencies.randomId() };
      saveDraft(draft);
      update({
        draft,
        submission: { phase: 'editing' },
        message: { kind: 'notice', text: 'Submission undone. Make any changes, then submit again.' }
      });
      return 'undone';
    } catch (error) {
      update({
        submission,
        message: { kind: 'error', text: errorMessage(error, 'The submission could not be undone. Try again.') }
      });
      return 'failed';
    }
  }

  return { state, updateDraft, setWebsite, submit, undo };
}

export function firstInvalidField(draft: Draft): FieldError | undefined {
  const requiredFields: (keyof typeof REQUIRED_FIELD_MESSAGES)[] =
    draft.matchType === 'D'
      ? ['side1Player1', 'side1Player2', 'side2Player1', 'side2Player2', 'score']
      : ['side1Player1', 'side2Player1', 'score'];
  const missingField = requiredFields.find(field => !draft[field].trim());
  if (missingField) {
    return { field: missingField, message: REQUIRED_FIELD_MESSAGES[missingField] };
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

function restoreDraft(dependencies: MatchEntryDependencies): Draft {
  const saved = savedDraft(dependencies.storage);
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  return {
    matchType: MATCH_TYPES.find(matchType => matchType === saved.matchType) ?? 'S',
    side1Player1: text(saved.side1Player1),
    side1Player2: text(saved.side1Player2),
    side2Player1: text(saved.side2Player1),
    side2Player2: text(saved.side2Player2),
    score: text(saved.score),
    handicap: text(saved.handicap),
    tournament: saved.tournament === true,
    requestId: text(saved.requestId) || dependencies.randomId()
  };
}

function savedDraft(storage: MatchEntryDependencies['storage']): Record<string, unknown> {
  try {
    const serialized = storage.getItem(DRAFT_KEY);
    const parsed: unknown = serialized ? JSON.parse(serialized) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    storage.removeItem(DRAFT_KEY);
    return {};
  }
}

function clientId(dependencies: MatchEntryDependencies): string {
  let id = dependencies.storage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = dependencies.randomId();
    dependencies.storage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
