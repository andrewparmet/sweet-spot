import { useState } from 'preact/hooks';
import type { AdminQueueItem, QueueView } from './api.ts';
import { EntryForm } from './entry-form.tsx';
import type { EntryModel } from './entry-model.ts';
import {
  formatEntryTimestamp,
  formatHistoryWeek,
  formatMatchDate,
  handicapLabel,
  isDeletable,
  isReviewable,
  matchCategory,
  rtoMatchUrl,
  statusClass,
  teamName
} from './format.ts';
import type { QueueModel } from './queue-model.ts';
import { ReviewDialog } from './review-dialog.tsx';
import type { ReviewModel } from './review-model.ts';
import type { SessionModel } from './session-model.ts';

interface AppProps {
  readonly environment: string;
  readonly session: SessionModel;
  readonly queue: QueueModel;
  readonly review: ReviewModel;
  readonly entry: EntryModel;
}

export function App({ environment, session, queue, review, entry }: AppProps) {
  return (
    <>
      {session.state.value.signedIn ? (
        <QueueScreen environment={environment} session={session} queue={queue} review={review} entry={entry} />
      ) : (
        <LoginScreen environment={environment} session={session} />
      )}
      <ReviewDialog review={review} />
    </>
  );
}

function LoginScreen({ environment, session }: Pick<AppProps, 'environment' | 'session'>) {
  const { identifier, password, signingIn, error } = session.state.value;
  return (
    <main class="login-shell">
      <section class="login-card" aria-labelledby="login-title">
        <div class="login-heading">
          <BallMark />
          <div>
            <p class="eyebrow">{environment}</p>
            <h1 id="login-title">Score Review</h1>
          </div>
        </div>
        <p class="login-copy">Sign in with an RTO match administrator account.</p>
        <form
          id="login-form"
          noValidate
          onSubmit={event => {
            event.preventDefault();
            void session.login();
          }}
        >
          <label>
            <span>RTO number or email</span>
            <input
              name="identifier"
              autocomplete="username"
              required
              value={identifier}
              onInput={event => session.setIdentifier(event.currentTarget.value)}
            />
          </label>
          <label>
            <span>Password</span>
            <input
              name="password"
              type="password"
              autocomplete="current-password"
              required
              value={password}
              onInput={event => session.setPassword(event.currentTarget.value)}
            />
          </label>
          {error && (
            <div class="login-error" role="alert">
              {error}
            </div>
          )}
          <button id="login-button" class="primary-button" type="submit" disabled={signingIn}>
            {signingIn ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  );
}

function QueueScreen({ environment, session, queue, review, entry }: AppProps) {
  const [entering, setEntering] = useState(false);
  const { view, loading } = queue.state.value;

  function showQueue(selected: QueueView): void {
    if (entering && view === selected) {
      void queue.load();
    } else {
      queue.selectView(selected);
    }
    setEntering(false);
  }

  return (
    <main class="page-shell">
      <header class="page-header">
        <div>
          <h1>Score Review</h1>
        </div>
        <div class="header-actions">
          <div class="environment">{environment}</div>
          <button class="text-button" type="button" onClick={() => session.signOut()}>
            Sign out
          </button>
        </div>
      </header>

      <section class="inbox" aria-label="Score queue">
        <div class="section-heading">
          <div class="queue-tabs" role="tablist" aria-label="Queue view">
            <button
              type="button"
              role="tab"
              aria-selected={!entering && view === 'review'}
              onClick={() => showQueue('review')}
            >
              Needs review
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={!entering && view === 'history'}
              onClick={() => showQueue('history')}
            >
              History
            </button>
            <button type="button" role="tab" aria-selected={entering} onClick={() => setEntering(true)}>
              Enter score
            </button>
          </div>
          {!entering && (
            <button id="refresh-button" type="button" disabled={loading} onClick={() => void queue.load()}>
              Refresh
            </button>
          )}
        </div>
        {entering ? <EntryForm entry={entry} /> : <QueueContent queue={queue} review={review} />}
      </section>
    </main>
  );
}

function QueueContent({ queue, review }: Pick<AppProps, 'queue' | 'review'>) {
  const { items, page, hasNext, week, loading, deletingId } = queue.state.value;
  const message = queue.message.value;
  return (
    <>
      <div class="queue-message" role="status" hidden={!message}>
        {message}
      </div>
      <div class="queue-list">
        {items.map(item => (
          <MatchCard
            key={item.record.submissionId}
            item={item}
            deleting={deletingId === item.record.submissionId}
            onReview={() => void review.open(item)}
            onDelete={() => void queue.remove(item)}
          />
        ))}
      </div>
      <nav class="history-pagination" aria-label="History pages" hidden={!queue.showPagination.value}>
        <button class="secondary-button" type="button" disabled={loading || page === 0} onClick={queue.previousPage}>
          Previous
        </button>
        <span aria-live="polite">{formatHistoryWeek(week)}</span>
        <button class="secondary-button" type="button" disabled={loading || !hasNext} onClick={queue.nextPage}>
          Next
        </button>
      </nav>
    </>
  );
}

interface MatchCardProps {
  readonly item: AdminQueueItem;
  readonly deleting: boolean;
  readonly onReview: () => void;
  readonly onDelete: () => void;
}

function MatchCard({ item, deleting, onReview, onDelete }: MatchCardProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const { record } = item;
  const matchUrl = rtoMatchUrl(record.rtoMatchId);
  return (
    <article class="match-card">
      <div class="match-topline">
        <div class="metadata">
          <span class={statusClass(record.status)}>{record.status}</span>
          <span class="date" title={formatEntryTimestamp(record.submittedAt)}>
            {formatMatchDate(record.matchDate)}
          </span>
        </div>
        <span class="match-type">{record.matchType === 'D' ? 'Doubles' : 'Singles'}</span>
      </div>
      <div class="matchup">
        <div class="team">{teamName(record, 1)}</div>
        <div class="versus">vs</div>
        <div class="team">{teamName(record, 2)}</div>
      </div>
      <dl class="details">
        <dt>Score</dt>
        <dd>{record.scoreOriginal}</dd>
        <dt>{handicapLabel(record)}</dt>
        <dd>{record.handicapOriginal || 'Level'}</dd>
        <dt>Type</dt>
        <dd>{matchCategory(record)}</dd>
        {record.rtoMatchId && (
          <>
            <dt>RTO match</dt>
            <dd>
              {matchUrl ? (
                <a href={matchUrl} target="_blank" rel="noopener noreferrer">
                  {record.rtoMatchId}
                </a>
              ) : (
                record.rtoMatchId
              )}
            </dd>
          </>
        )}
        {record.lastError && (
          <>
            <dt class="error-label">Error</dt>
            <dd class="error-copy">{record.lastError}</dd>
          </>
        )}
      </dl>
      {isDeletable(record) && (
        <div class="card-footer">
          {confirmingDelete ? (
            <>
              {record.status === 'Submitted' && rtoMatchUrl(record.rtoMatchId) && (
                <span class="card-footer-note">{`Deletes RTO match ${record.rtoMatchId}.`}</span>
              )}
              <button class="text-button" type="button" disabled={deleting} onClick={() => setConfirmingDelete(false)}>
                Keep
              </button>
              <button class="card-action danger-action" type="button" disabled={deleting} onClick={onDelete}>
                {deleting ? 'Deleting…' : 'Confirm delete'}
              </button>
            </>
          ) : (
            <>
              <button class="text-button" type="button" onClick={() => setConfirmingDelete(true)}>
                Delete
              </button>
              {isReviewable(record) && (
                <button class="card-action" type="button" onClick={onReview}>
                  Review
                </button>
              )}
            </>
          )}
        </div>
      )}
    </article>
  );
}

function BallMark() {
  return (
    <div class="ball-mark" aria-hidden="true">
      <svg viewBox="0 0 48 48" focusable="false">
        <path class="seam-ridge" d="M9-2C17 11 17 37 9 50M39-2C31 11 31 37 39 50" />
        <path
          class="seam-stitches"
          d="M9.5 4.2l4-2M11.5 10.8l4-2M12.7 18l4-2M13 25l4-2M12.7 32l4-2M11.5 39.2l4-2M9.5 45.8l4-2M34.5 2.2l4 2M32.5 8.8l4 2M31.3 16l4 2M31 23l4 2M31.3 30l4 2M32.5 37.2l4 2M34.5 43.8l4 2"
        />
      </svg>
    </div>
  );
}
