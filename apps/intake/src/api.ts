import type {
  MatchSubmissionRequest,
  MatchSubmissionResponse,
  UndoSubmissionRequest,
  UndoSubmissionResponse
} from '../../../packages/shared/src/match.ts';

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

export function submitMatch(payload: MatchSubmissionRequest): Promise<MatchSubmissionResponse> {
  return callServer('submitMatch', payload);
}

export function undoSubmission(payload: UndoSubmissionRequest): Promise<UndoSubmissionResponse> {
  return callServer('undoSubmission', payload);
}

export function randomId(): string {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function callServer<T>(functionName: BridgeRequest['functionName'], payload: BridgeRequest['payload']): Promise<T> {
  return new Promise((resolve, reject) => {
    if (appsScriptRunner) {
      const runner = appsScriptRunner.withSuccessHandler<T>(resolve).withFailureHandler(reject);
      if (functionName === 'submitMatch') {
        runner.submitMatch(payload as MatchSubmissionRequest);
      } else {
        runner.undoSubmission(payload as UndoSubmissionRequest);
      }
      return;
    }
    if (!bridgeConnection) {
      reject(new Error('The submission service is unavailable.'));
      return;
    }

    const id = randomId();
    bridgeCalls.set(id, { resolve: result => resolve(result as T), reject });
    bridgeConnection
      .then(port => {
        const request: BridgeRequest = { type: 'sweet-spot-intake-request', id, functionName, payload };
        port.postMessage(request);
      })
      .catch(error => {
        bridgeCalls.delete(id);
        reject(error instanceof Error ? error : new Error('The submission service could not start.'));
      });
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
