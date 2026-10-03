import { render } from 'preact';
import {
  adminLogin,
  bostonToday,
  clearSessionToken,
  deleteQueuedMatch,
  isAuthenticationError,
  loadAdminQueue,
  loadSanctionedMatches,
  saveSessionToken,
  sessionToken,
  submitAdminEntry,
  submitReviewedMatch
} from './api.ts';
import { App } from './app.tsx';
import { clearDirectoryCache, expandPlayerSearch, loadBostonPlayers, preloadBostonPlayers } from './directory.ts';
import { createEntryModel } from './entry-model.ts';
import { createQueueModel } from './queue-model.ts';
import { createReviewModel } from './review-model.ts';
import { createSessionModel } from './session-model.ts';

declare const SWEET_SPOT_ENVIRONMENT: string;

enforceTrustedFrame();

const queue = createQueueModel({
  loadAdminQueue,
  deleteQueuedMatch,
  isAuthenticationError,
  onAuthenticationError: message => session.signOut(message)
});
const review = createReviewModel({
  loadBostonPlayers,
  expandPlayerSearch,
  loadSanctionedMatches,
  submitReviewedMatch,
  onSubmitted: () => void queue.load()
});
const entry = createEntryModel({ randomId: () => crypto.randomUUID(), today: bostonToday, submitAdminEntry });
const session = createSessionModel({
  hasSession: () => Boolean(sessionToken()),
  adminLogin,
  saveSession: saveSessionToken,
  clearSession: () => {
    clearSessionToken();
    clearDirectoryCache();
  },
  onSignedIn: startSession,
  onSignedOut: () => {
    queue.reset();
    review.reset();
  }
});

render(
  <App environment={SWEET_SPOT_ENVIRONMENT} session={session} queue={queue} review={review} entry={entry} />,
  requiredElement('app')
);
if (session.state.value.signedIn) {
  startSession();
}

function startSession(): void {
  preloadBostonPlayers();
  void queue.load();
}

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element: ${id}`);
  }
  return element;
}

function enforceTrustedFrame(): void {
  if (window.top === window.self) {
    return;
  }
  const trustedOrigin = 'https://andrewparmet.github.io';
  const ancestorOrigins = Array.from(window.location.ancestorOrigins ?? []);
  const referrerOrigin = (() => {
    try {
      return document.referrer ? new URL(document.referrer).origin : '';
    } catch {
      return '';
    }
  })();
  if (ancestorOrigins.includes(trustedOrigin) || referrerOrigin === trustedOrigin) {
    return;
  }
  const frameError = document.createElement('main');
  frameError.className = 'frame-error';
  frameError.textContent = 'Open Score Review from the Sweet Spot site.';
  document.body.replaceChildren(frameError);
  throw new Error('Score Review was embedded by an untrusted site.');
}
