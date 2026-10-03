import type { JSX } from 'preact';
import { useRef } from 'preact/hooks';
import type { EntryDraft, EntryFieldName, EntryModel } from './entry-model.ts';

type TextInputProps = Omit<JSX.InputHTMLAttributes<HTMLInputElement>, 'name' | 'value' | 'onInput'>;

export function EntryForm({ entry }: { readonly entry: EntryModel }) {
  const form = useRef<HTMLFormElement>(null);
  const { draft, submitting, message, fieldError } = entry.state.value;
  const doubles = draft.matchType === 'D';

  function field(name: EntryFieldName, label: string, props: TextInputProps) {
    const invalid = fieldError?.field === name;
    return (
      <label class="entry-field">
        <span>{label}</span>
        <input
          {...props}
          name={name}
          value={draft[name]}
          disabled={submitting}
          aria-invalid={invalid ? 'true' : undefined}
          onInput={event => entry.updateDraft({ [name]: event.currentTarget.value })}
        />
        {invalid && <span class="field-error">{fieldError.message}</span>}
      </label>
    );
  }

  function playerField(name: EntryFieldName, label: string) {
    return field(name, label, { type: 'text', autocomplete: 'off', autocapitalize: 'words', maxLength: 100 });
  }

  function matchTypeTab(matchType: EntryDraft['matchType'], label: string) {
    return (
      <button
        type="button"
        role="radio"
        aria-checked={draft.matchType === matchType}
        disabled={submitting}
        onClick={() => entry.updateDraft({ matchType })}
      >
        {label}
      </button>
    );
  }

  function checkbox(name: 'tournament' | 'sanctioned', label: string, onChange: (checked: boolean) => void) {
    return (
      <label class="entry-check">
        <input
          name={name}
          type="checkbox"
          checked={draft[name]}
          disabled={submitting}
          onChange={event => onChange(event.currentTarget.checked)}
        />
        <span>{label}</span>
      </label>
    );
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const outcome = await entry.submit();
    const target = outcome === 'invalid' ? entry.state.value.fieldError?.field : 'side1Player1';
    const input = target && outcome !== 'failed' ? form.current?.elements.namedItem(target) : undefined;
    if (input instanceof HTMLInputElement) {
      window.setTimeout(() => input.focus());
    }
  }

  return (
    <form ref={form} class="entry-form" noValidate onSubmit={event => void submit(event)}>
      <div class="queue-tabs entry-match-type" role="radiogroup" aria-label="Match type">
        {matchTypeTab('S', 'Singles')}
        {matchTypeTab('D', 'Doubles')}
      </div>
      {field('matchDate', 'Match date', { type: 'date', max: entry.today(), required: true })}
      <fieldset class="entry-side">
        <legend>Side 1</legend>
        {playerField('side1Player1', 'Player')}
        {doubles && playerField('side1Player2', 'Partner')}
      </fieldset>
      <fieldset class="entry-side">
        <legend>Side 2</legend>
        {playerField('side2Player1', 'Player')}
        {doubles && playerField('side2Player2', 'Partner')}
      </fieldset>
      {field('score', 'Result', { type: 'text', autocomplete: 'off', maxLength: 100, placeholder: '6-2,6-1' })}
      {field('handicap', 'Odds (optional)', {
        type: 'text',
        autocomplete: 'off',
        autocapitalize: 'none',
        maxLength: 60,
        placeholder: '-15/15 or -h15/15'
      })}
      {checkbox('tournament', 'Tournament', entry.setTournament)}
      {checkbox('sanctioned', 'Sanctioned tournament', entry.setSanctioned)}
      <div
        class={message?.kind === 'notice' ? 'entry-message notice' : 'entry-message'}
        role="status"
        hidden={!message}
      >
        {message?.text}
      </div>
      <button class="primary-button" type="submit" disabled={submitting}>
        {submitting ? 'Adding…' : 'Add score'}
      </button>
    </form>
  );
}
