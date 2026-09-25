import { isValidOdds, isValidScore } from '../../../packages/shared/src/match.ts';
import type {
  HandicapEntryType,
  MatchSubmissionRequest,
  MatchSubmissionResponse,
  MatchType,
  UndoSubmissionRequest,
  UndoSubmissionResponse
} from '../../../packages/shared/src/match.ts';

const DRAFT_KEY = 'sweet-spot-draft-v1';
const CLIENT_ID_KEY = 'sweet-spot-client-id-v1';
const form = requiredElement<HTMLFormElement>('match-form');
const formMessage = requiredElement<HTMLElement>('form-message');
const submitButton = requiredElement<HTMLButtonElement>('submit-button');
const buttonLabel = requiredDescendant<HTMLElement>(submitButton, '.button-label');
const partnerFields = Array.from(document.querySelectorAll<HTMLElement>('.partner-field'));
const handicapInput = form.elements.namedItem('handicap') as HTMLInputElement;
const scoreInput = form.elements.namedItem('score') as HTMLInputElement;
let pendingRequestId = randomId();
let lastSubmission: UndoSubmissionRequest | undefined;
let lastSubmittedDraft: Draft | undefined;

interface Draft {
  readonly matchType: MatchType;
  readonly side1Player1: string;
  readonly side1Player2: string;
  readonly side2Player1: string;
  readonly side2Player2: string;
  readonly score: string;
  readonly handicapType: HandicapEntryType;
  readonly handicap: string;
  readonly tournament: boolean;
  readonly requestId: string;
}

interface AppsScriptRunner {
  withSuccessHandler<T>(handler: (result: T) => void): AppsScriptRunner;
  withFailureHandler(handler: (error: Error) => void): AppsScriptRunner;
  submitMatch(payload: MatchSubmissionRequest): void;
  undoSubmission(payload: UndoSubmissionRequest): void;
}

interface BridgeRequest {
  readonly type: 'sweet-spot-intake-request';
  readonly id: string;
  readonly functionName: 'submitMatch' | 'undoSubmission';
  readonly payload: MatchSubmissionRequest | UndoSubmissionRequest;
}

interface BridgeResponse {
  readonly type: 'sweet-spot-intake-response';
  readonly id: string;
  readonly result?: unknown;
  readonly error?: string;
}

const appsScriptRunner = (
  globalThis as typeof globalThis & { readonly google?: { readonly script?: { readonly run?: AppsScriptRunner } } }
).google?.script?.run;
const bridgeUrl = (globalThis as typeof globalThis & { readonly SWEET_SPOT_INTAKE_BRIDGE_URL?: string })
  .SWEET_SPOT_INTAKE_BRIDGE_URL;
const bridgeConnection = bridgeUrl ? connectBridge(bridgeUrl) : undefined;
const bridgeCalls = new Map<
  string,
  { readonly resolve: (result: unknown) => void; readonly reject: (error: Error) => void }
>();

function callServer<T>(
  functionName: BridgeRequest['functionName'],
  payload: BridgeRequest['payload'],
  onSuccess: (result: T) => void,
  onFailure: (error: Error) => void
): void {
  if (appsScriptRunner) {
    const runner = appsScriptRunner.withSuccessHandler(onSuccess).withFailureHandler(onFailure);
    if (functionName === 'submitMatch') {
      runner.submitMatch(payload as MatchSubmissionRequest);
    } else {
      runner.undoSubmission(payload as UndoSubmissionRequest);
    }
    return;
  }
  if (!bridgeConnection) {
    onFailure(new Error('The submission service is unavailable.'));
    return;
  }

  const id = randomId();
  bridgeCalls.set(id, {
    resolve: result => onSuccess(result as T),
    reject: onFailure
  });
  bridgeConnection
    .then(port => {
      const request: BridgeRequest = { type: 'sweet-spot-intake-request', id, functionName, payload };
      port.postMessage(request);
    })
    .catch(error => {
      bridgeCalls.delete(id);
      onFailure(error instanceof Error ? error : new Error('The submission service could not start.'));
    });
}

function connectBridge(url: string): Promise<MessagePort> {
  const channelId = randomId();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener('message', handleConnection);
      reject(new Error('The submission service took too long to start.'));
    }, 30_000);
    const handleConnection = (event: MessageEvent): void => {
      if (
        !/^https:\/\/[a-z0-9-]+-script\.googleusercontent\.com$/.test(event.origin) ||
        event.data?.type !== 'sweet-spot-intake-connect' ||
        event.data.channelId !== channelId ||
        !event.ports[0]
      ) {
        return;
      }
      window.removeEventListener('message', handleConnection);
      const port = event.ports[0];
      port.onmessage = bridgeEvent => {
        if (bridgeEvent.data?.type === 'sweet-spot-intake-ready') {
          window.clearTimeout(timeout);
          resolve(port);
          return;
        }
        if (bridgeEvent.data?.type === 'sweet-spot-intake-unavailable') {
          window.clearTimeout(timeout);
          reject(new Error(bridgeEvent.data.error || 'The submission service could not start.'));
          return;
        }
        const response = bridgeEvent.data as BridgeResponse;
        if (response?.type !== 'sweet-spot-intake-response') {
          return;
        }
        const call = bridgeCalls.get(response.id);
        if (!call) {
          return;
        }
        bridgeCalls.delete(response.id);
        if (response.error) {
          call.reject(new Error(response.error));
        } else {
          call.resolve(response.result);
        }
      };
      port.start();
    };
    window.addEventListener('message', handleConnection);

    const frame = document.createElement('iframe');
    frame.title = 'Submission service';
    frame.hidden = true;
    frame.src = `${url}&channel=${encodeURIComponent(channelId)}`;
    document.body.append(frame);
  });
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element: ${id}`);
  }
  return element as T;
}

function requiredDescendant<T extends Element>(parent: Element, selector: string): T {
  const element = parent.querySelector(selector);
  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }
  return element as T;
}

function randomId(): string {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function getClientId(): string {
  let clientId = localStorage.getItem(CLIENT_ID_KEY);
  if (!clientId) {
    clientId = randomId();
    localStorage.setItem(CLIENT_ID_KEY, clientId);
  }
  return clientId;
}

function getSelectedValue<T extends string>(name: string): T {
  const selected = form.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`);
  if (!selected) {
    throw new Error(`Missing selection: ${name}`);
  }
  return selected.value as T;
}

function setSelectedValue(name: string, value: string): void {
  const input = form.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
  if (input) {
    input.checked = true;
  }
}

function namedInput(name: string): HTMLInputElement {
  const input = form.elements.namedItem(name);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Missing input: ${name}`);
  }
  return input;
}

function updateMatchType(): void {
  const doubles = getSelectedValue<MatchType>('matchType') === 'D';
  partnerFields.forEach(field => {
    field.hidden = !doubles;
    const input = requiredDescendant<HTMLInputElement>(field, 'input');
    input.required = doubles;
    if (!doubles) {
      input.setCustomValidity('');
    }
  });
}

function updateHandicapType(): void {
  const difference = getSelectedValue<HandicapEntryType>('handicapType') === 'difference';
  handicapInput.setAttribute('aria-label', difference ? 'Handicap difference' : 'Odds played');
  handicapInput.placeholder = difference ? '-10' : '-15/15 or -h15/15';
  handicapInput.inputMode = difference ? 'decimal' : 'text';
  handicapInput.setCustomValidity('');
}

function currentDraft(): Draft {
  return {
    matchType: getSelectedValue('matchType'),
    side1Player1: namedInput('side1Player1').value,
    side1Player2: namedInput('side1Player2').value,
    side2Player1: namedInput('side2Player1').value,
    side2Player2: namedInput('side2Player2').value,
    score: namedInput('score').value,
    handicapType: getSelectedValue('handicapType'),
    handicap: handicapInput.value,
    tournament: namedInput('tournament').checked,
    requestId: pendingRequestId
  };
}

function saveDraft(): void {
  localStorage.setItem(DRAFT_KEY, JSON.stringify(currentDraft()));
}

function applyDraft(draft: Partial<Draft>): void {
  setSelectedValue('matchType', draft.matchType ?? 'S');
  setSelectedValue('handicapType', draft.handicapType ?? 'odds');
  (['side1Player1', 'side1Player2', 'side2Player1', 'side2Player2', 'score', 'handicap'] as const).forEach(name => {
    namedInput(name).value = draft[name] ?? '';
  });
  namedInput('tournament').checked = draft.tournament === true;
  pendingRequestId = draft.requestId || pendingRequestId;
}

function restoreDraft(): void {
  try {
    const serialized = localStorage.getItem(DRAFT_KEY);
    if (!serialized) {
      return;
    }
    applyDraft(JSON.parse(serialized) as Partial<Draft>);
  } catch {
    localStorage.removeItem(DRAFT_KEY);
  }
}

function setSubmitButton(mode: 'submit' | 'submitting' | 'undo' | 'undoing'): void {
  submitButton.type = mode === 'submit' ? 'submit' : 'button';
  submitButton.disabled = mode === 'submitting' || mode === 'undoing';
  buttonLabel.textContent = {
    submit: 'Submit score',
    submitting: 'Submitting…',
    undo: 'Undo',
    undoing: 'Undoing…'
  }[mode];
}

function setFormLocked(locked: boolean): void {
  Array.from(form.elements).forEach(control => {
    if (control instanceof HTMLInputElement || control instanceof HTMLButtonElement) {
      control.disabled = locked;
    }
  });
}

function showError(error: Error): void {
  lastSubmission = undefined;
  formMessage.classList.remove('notice');
  formMessage.textContent = error.message || 'The score could not be submitted. Try again.';
  formMessage.hidden = false;
  formMessage.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  setFormLocked(false);
  setSubmitButton('submit');
}

function showSuccess(result: MatchSubmissionResponse): void {
  lastSubmission = {
    submissionId: result.submissionId,
    requestId: lastSubmittedDraft?.requestId ?? pendingRequestId
  };
  localStorage.removeItem(DRAFT_KEY);
  setSubmitButton('undo');
}

function showUndoError(error: Error): void {
  formMessage.classList.remove('notice');
  formMessage.textContent = error.message || 'The submission could not be undone. Try again.';
  formMessage.hidden = false;
  setSubmitButton('undo');
}

function showUndoSuccess(): void {
  if (lastSubmittedDraft) {
    applyDraft({ ...lastSubmittedDraft, requestId: randomId() });
  } else {
    pendingRequestId = randomId();
  }
  saveDraft();
  lastSubmission = undefined;
  lastSubmittedDraft = undefined;
  setFormLocked(false);
  setSubmitButton('submit');
  formMessage.textContent = 'Submission undone. Make any changes, then submit again.';
  formMessage.classList.add('notice');
  formMessage.hidden = false;
  updateMatchType();
  updateHandicapType();
  namedInput('score').focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function validateHandicap(): boolean {
  if (!handicapInput.value.trim()) {
    handicapInput.setCustomValidity('');
    return true;
  }
  const difference = getSelectedValue<HandicapEntryType>('handicapType') === 'difference';
  const valid = difference ? /^[+-]?\d+(?:\.\d+)?$/.test(handicapInput.value.trim()) : isValidOdds(handicapInput.value);
  const message = difference
    ? 'Enter a numeric handicap difference, such as -16.'
    : 'Enter two valid odds scores, such as -15/15 or -h15/15.';
  handicapInput.setCustomValidity(valid ? '' : message);
  return valid;
}

function validateScore(): boolean {
  if (!scoreInput.value.trim()) {
    scoreInput.setCustomValidity('');
    return false;
  }
  const valid = isValidScore(scoreInput.value);
  scoreInput.setCustomValidity(valid ? '' : 'Enter game scores like 6-2,6-1 or 10-8.');
  return valid;
}

function clearFieldError(): void {
  form.querySelector('.field-error')?.remove();
  form.querySelector('[aria-invalid="true"]')?.removeAttribute('aria-invalid');
}

function requiredFieldMessage(input: HTMLInputElement): string {
  const messages: Record<string, string> = {
    score: 'Enter the result.',
    side1Player1: 'Enter the Side 1 player.',
    side1Player2: 'Enter the Side 1 partner.',
    side2Player1: 'Enter the Side 2 player.',
    side2Player2: 'Enter the Side 2 partner.'
  };
  return messages[input.name] ?? 'Complete this field.';
}

function showFieldError(input: HTMLInputElement): void {
  clearFieldError();
  const message = document.createElement('span');
  message.className = 'field-error';
  message.textContent = input.validity.valueMissing ? requiredFieldMessage(input) : input.validationMessage;
  input.setAttribute('aria-invalid', 'true');
  (input.closest('.text-field') ?? input.parentElement)?.append(message);
  input.focus();
  input.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function firstInvalidInput(): HTMLInputElement | undefined {
  const missingInput = Array.from(form.querySelectorAll<HTMLInputElement>('input[required]')).find(
    input => !input.value.trim()
  );
  if (missingInput) {
    return missingInput;
  }
  if (!validateScore()) {
    return scoreInput;
  }
  if (!validateHandicap()) {
    return handicapInput;
  }
  return form.querySelector<HTMLInputElement>('input:invalid') ?? undefined;
}

form.addEventListener('change', event => {
  const target = event.target as HTMLInputElement;
  if (target.name === 'matchType') {
    updateMatchType();
  }
  if (target.name === 'handicapType') {
    updateHandicapType();
  }
  saveDraft();
});

form.addEventListener('input', event => {
  clearFieldError();
  if (event.target === scoreInput) {
    validateScore();
  }
  if (event.target === handicapInput) {
    validateHandicap();
  }
  saveDraft();
});

form.addEventListener('submit', event => {
  event.preventDefault();
  formMessage.hidden = true;
  clearFieldError();
  const invalidInput = firstInvalidInput();
  if (invalidInput) {
    showFieldError(invalidInput);
    return;
  }

  const draft = currentDraft();
  lastSubmittedDraft = draft;
  const payload: MatchSubmissionRequest = {
    ...draft,
    website: namedInput('website').value,
    clientId: getClientId()
  };
  setFormLocked(true);
  setSubmitButton('submitting');

  callServer<MatchSubmissionResponse>('submitMatch', payload, showSuccess, showError);
});

submitButton.addEventListener('click', () => {
  if (!lastSubmission) {
    return;
  }
  formMessage.hidden = true;
  setSubmitButton('undoing');
  callServer<UndoSubmissionResponse>('undoSubmission', lastSubmission, showUndoSuccess, showUndoError);
});

restoreDraft();
updateMatchType();
updateHandicapType();
