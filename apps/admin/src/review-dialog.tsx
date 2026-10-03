import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import type { DirectoryPlayer } from './api.ts';
import { teamName } from './format.ts';
import {
  isValidHandicap,
  playerOptions,
  type ExpansionStatus,
  type PlayerSlot,
  type ReviewForm,
  type ReviewModel
} from './review-model.ts';
import { scoreError } from '../../../packages/shared/src/match.ts';
import { DUPLICATE_MATCH_MESSAGE } from './rto-match.ts';

const EXPAND_LABELS: Record<ExpansionStatus, string> = {
  idle: 'Expand search',
  expanding: 'Searching…',
  expanded: 'Expanded'
};

export function ReviewDialog({ review }: { readonly review: ReviewModel }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const state = review.state.value;
  const open = state.phase !== 'closed';
  const submitting = state.phase === 'submitting';
  const form = state.phase === 'editing' || state.phase === 'submitting' ? state : undefined;
  const duplicateWarning = form?.duplicateWarning === true;
  const error =
    state.phase === 'failed'
      ? state.error
      : duplicateWarning
        ? `${form?.error ?? DUPLICATE_MATCH_MESSAGE} Submit anyway if this is a separate match.`
        : form?.error;

  useEffect(() => {
    const element = dialog.current;
    if (open && !element?.open) {
      element?.showModal();
    }
    if (!open && element?.open) {
      element.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialog}
      aria-labelledby="dialog-title"
      onCancel={event => {
        if (submitting) {
          event.preventDefault();
        }
      }}
      onClose={review.close}
    >
      <div class="dialog-shell">
        <div class="dialog-heading">
          <div>
            <h2 id="dialog-title">Review score</h2>
          </div>
          <button class="close-button" type="button" aria-label="Close" disabled={submitting} onClick={review.close}>
            ×
          </button>
        </div>
        {state.phase === 'loading' && (
          <div class="dialog-loading" role="status">
            <span class="spinner" aria-hidden="true"></span>
            <span>Loading player directory…</span>
          </div>
        )}
        {form && <ReviewContent review={review} form={form} />}
        {error && (
          <div class="dialog-error" role="alert">
            {error}
          </div>
        )}
        {form && (
          <div class="dialog-actions">
            <button class="secondary-button" type="button" disabled={submitting} onClick={review.close}>
              Cancel
            </button>
            <button
              class="primary-button"
              type="button"
              disabled={!review.canSubmit.value}
              onClick={() => void review.submit()}
            >
              {submitting ? 'Submitting…' : duplicateWarning ? 'Submit anyway' : 'Submit'}
            </button>
          </div>
        )}
      </div>
    </dialog>
  );
}

function ReviewContent({ review, form }: { readonly review: ReviewModel; readonly form: ReviewForm }) {
  const { record } = form.item;
  const invalidScore = scoreError(form.score);
  const sides = [1, 2].map(side => form.slots.flatMap((slot, index) => (slot.side === side ? [{ slot, index }] : [])));
  return (
    <div>
      <div class="dialog-match">{`${teamName(record, 1)} vs ${teamName(record, 2)}`}</div>
      <label class="score-override" for="review-score">
        <span>Score</span>
        <input
          id="review-score"
          type="text"
          inputMode="numeric"
          autocomplete="off"
          maxLength={100}
          value={form.score}
          aria-invalid={invalidScore ? 'true' : undefined}
          onInput={event => review.setScore(event.currentTarget.value)}
        />
        {invalidScore && <span class="field-error">{invalidScore}</span>}
      </label>
      <label class="score-override" for="review-handicap">
        <span>{record.handicapEntryType === 'difference' ? 'Difference' : 'Odds'}</span>
        <input
          id="review-handicap"
          type="text"
          autocomplete="off"
          autocapitalize="none"
          maxLength={60}
          placeholder="Level"
          value={form.handicap}
          aria-invalid={isValidHandicap(record, form.handicap) ? undefined : 'true'}
          onInput={event => review.setHandicap(event.currentTarget.value)}
        />
      </label>
      {record.sanctioned && (
        <label class="score-override" for="review-sanctioned-match">
          <span>Sanctioned match</span>
          <select
            id="review-sanctioned-match"
            onChange={event => review.selectSanctionedMatch(event.currentTarget.value)}
          >
            <option value="" selected={!form.sanctionedMatch} disabled>
              Choose the sanctioned match
            </option>
            {form.sanctionedMatches.map(match => (
              <option key={match.id} value={match.description} selected={match.description === form.sanctionedMatch}>
                {match.description}
              </option>
            ))}
          </select>
        </label>
      )}
      <div class="player-matches">
        {sides.map((slots, sideIndex) => (
          <section key={sideIndex} class="player-side">
            <h3 class="player-side-title">{`Side ${sideIndex + 1}`}</h3>
            {slots.map(({ slot, index }) => (
              <PlayerField key={index} review={review} boston={form.boston} slot={slot} index={index} />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

interface PlayerFieldProps {
  readonly review: ReviewModel;
  readonly boston: readonly DirectoryPlayer[];
  readonly slot: PlayerSlot;
  readonly index: number;
}

function PlayerField({ review, boston, slot, index }: PlayerFieldProps) {
  const manualInput = useRef<HTMLInputElement>(null);
  const options = playerOptions(slot.rankingName, boston, slot.expanded);
  const selectId = `player-match-${index}`;

  useLayoutEffect(() => {
    if (slot.manualOpen) {
      manualInput.current?.focus();
      manualInput.current?.select();
    }
  }, [slot.manualOpen]);

  return (
    <div class="player-match">
      <div class="player-match-heading">
        <label for={selectId}>{slot.originalName}</label>
        <div class="player-search-actions">
          <button
            class="expand-search"
            type="button"
            disabled={slot.expansion !== 'idle'}
            onClick={() => void review.expand(index)}
          >
            {EXPAND_LABELS[slot.expansion]}
          </button>
          <button
            class="expand-search"
            type="button"
            aria-expanded={slot.manualOpen}
            onClick={() => review.toggleManualSearch(index)}
          >
            Manual search
          </button>
        </div>
      </div>
      <select id={selectId} onChange={event => review.selectPlayer(index, event.currentTarget.value)}>
        {options.bestMatchId ? (
          (
            [
              ['Boston players', options.boston],
              ['Wider directory', options.wider]
            ] as const
          ).map(
            ([groupLabel, players]) =>
              players.length > 0 && (
                <optgroup key={groupLabel} label={groupLabel}>
                  {players.map(player => (
                    <option key={player.id} value={player.id} selected={player.id === slot.selectedId}>
                      {`${player.name} (${player.handicap.toFixed(1)})`}
                    </option>
                  ))}
                </optgroup>
              )
          )
        ) : (
          <option value="" selected disabled>
            {slot.expanded.length
              ? 'No directory match. Search manually.'
              : 'No Boston match. Expand or search manually.'}
          </option>
        )}
      </select>
      <form
        class="manual-search"
        hidden={!slot.manualOpen}
        onSubmit={event => {
          event.preventDefault();
          if (!slot.manualQuery.trim()) {
            manualInput.current?.focus();
          }
          void review.searchManually(index);
        }}
      >
        <input
          ref={manualInput}
          type="search"
          autocomplete="off"
          aria-label={`Search RTO directory for ${slot.originalName}`}
          value={slot.manualQuery}
          disabled={slot.manualSearching}
          onInput={event => review.setManualQuery(index, event.currentTarget.value)}
        />
        <button class="secondary-button" type="submit" disabled={slot.manualSearching}>
          {slot.manualSearching ? 'Searching…' : 'Search'}
        </button>
      </form>
    </div>
  );
}
