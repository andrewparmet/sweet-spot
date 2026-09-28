import type { JSX } from 'preact';
import { useRef } from 'preact/hooks';
import type { Draft, MatchEntryModel, TextFieldName } from './match-entry-model.ts';

type TextInputProps = Omit<JSX.InputHTMLAttributes<HTMLInputElement>, 'name' | 'value' | 'onInput'>;

const SUBMIT_LABELS = {
  editing: 'Submit score',
  submitting: 'Submitting…',
  submitted: 'Undo',
  undoing: 'Undoing…'
} as const;

export function MatchEntry({ model }: { readonly model: MatchEntryModel }) {
  const form = useRef<HTMLFormElement>(null);
  const formMessage = useRef<HTMLDivElement>(null);
  const { draft, website, submission, message, fieldError } = model.state.value;
  const { phase } = submission;
  const locked = phase !== 'editing';
  const doubles = draft.matchType === 'D';

  function textInput(name: TextFieldName, props: TextInputProps) {
    const invalid = fieldError?.field === name;
    return (
      <>
        <input
          {...props}
          name={name}
          type="text"
          value={draft[name]}
          disabled={locked}
          aria-invalid={invalid ? 'true' : undefined}
          onInput={event => model.updateDraft({ [name]: event.currentTarget.value })}
        />
        {invalid && <span class="field-error">{fieldError.message}</span>}
      </>
    );
  }

  function radio(name: 'matchType', value: Draft['matchType'], label: string) {
    return (
      <label>
        <input
          type="radio"
          name={name}
          value={value}
          checked={draft[name] === value}
          disabled={locked}
          onChange={() => model.updateDraft({ [name]: value })}
        />
        <span>{label}</span>
      </label>
    );
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const outcome = await model.submit();
    const error = model.state.value.fieldError;
    if (outcome === 'invalid' && error) {
      const input = form.current?.elements.namedItem(error.field);
      if (input instanceof HTMLInputElement) {
        afterRender(() => {
          input.focus();
          input.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      }
    }
    if (outcome === 'failed') {
      afterRender(() => formMessage.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
    }
  }

  async function undo(): Promise<void> {
    if ((await model.undo()) === 'undone') {
      afterRender(() => {
        const score = form.current?.elements.namedItem('score');
        if (score instanceof HTMLInputElement) {
          score.focus();
        }
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }
  }

  return (
    <main class="page-shell">
      <section class="card" aria-labelledby="page-title">
        <header class="page-header">
          <div class="ball-mark" aria-hidden="true">
            <svg viewBox="0 0 48 48" focusable="false">
              <path class="seam-ridge" d="M9-2C17 11 17 37 9 50M39-2C31 11 31 37 39 50" />
              <path
                class="seam-stitches"
                d="M9.5 4.2l4-2M11.5 10.8l4-2M12.7 18l4-2M13 25l4-2M12.7 32l4-2M11.5 39.2l4-2M9.5 45.8l4-2M34.5 2.2l4 2M32.5 8.8l4 2M31.3 16l4 2M31 23l4 2M31.3 30l4 2M32.5 37.2l4 2M34.5 43.8l4 2"
              />
            </svg>
          </div>
          <div>
            <h1 id="page-title">Match Entry</h1>
          </div>
        </header>

        <form ref={form} id="match-form" noValidate onSubmit={event => void submit(event)}>
          <fieldset class="field-group">
            <div class="segmented-control" role="radiogroup" aria-label="Match type">
              {radio('matchType', 'S', 'Singles')}
              {radio('matchType', 'D', 'Doubles')}
            </div>
          </fieldset>

          <fieldset class="field-group team-group">
            <legend>Side 1</legend>
            <label class="text-field">
              {textInput('side1Player1', {
                autocomplete: 'name',
                autocapitalize: 'words',
                maxLength: 100,
                placeholder: 'Charlie Brown, C Brown, or Charlie B',
                'aria-label': 'Side 1 player',
                required: true
              })}
            </label>
            <label class="text-field partner-field" hidden={!doubles}>
              <span>Partner</span>
              {textInput('side1Player2', {
                autocomplete: 'name',
                autocapitalize: 'words',
                maxLength: 100,
                required: doubles
              })}
            </label>
          </fieldset>

          <fieldset class="field-group team-group">
            <legend>Side 2</legend>
            <label class="text-field">
              {textInput('side2Player1', {
                autocomplete: 'name',
                autocapitalize: 'words',
                maxLength: 100,
                'aria-label': 'Side 2 player',
                required: true
              })}
            </label>
            <label class="text-field partner-field" hidden={!doubles}>
              <span>Partner</span>
              {textInput('side2Player2', {
                autocomplete: 'name',
                autocapitalize: 'words',
                maxLength: 100,
                required: doubles
              })}
            </label>
          </fieldset>

          <fieldset class="field-group">
            <legend>Result (omit spaces)</legend>
            <label class="text-field">
              {textInput('score', {
                autocapitalize: 'none',
                maxLength: 100,
                placeholder: '6-2,6-1',
                'aria-label': 'Score',
                required: true
              })}
            </label>
          </fieldset>

          <fieldset class="field-group">
            <legend>Handicap (optional)</legend>
            <label class="text-field">
              {textInput('handicap', {
                inputMode: 'text',
                autocapitalize: 'none',
                maxLength: 60,
                placeholder: '-15/15 or -h15/15',
                'aria-label': 'Odds played'
              })}
            </label>
          </fieldset>

          <label class="check-field">
            <input
              name="tournament"
              type="checkbox"
              checked={draft.tournament}
              disabled={locked}
              onChange={event => model.updateDraft({ tournament: event.currentTarget.checked })}
            />
            <span class="check-box" aria-hidden="true"></span>
            <span>Tournament</span>
          </label>

          <div class="honeypot" aria-hidden="true">
            <label>
              Website{' '}
              <input
                name="website"
                type="text"
                tabIndex={-1}
                autocomplete="off"
                value={website}
                disabled={locked}
                onInput={event => model.setWebsite(event.currentTarget.value)}
              />
            </label>
          </div>

          <div
            ref={formMessage}
            class={message?.kind === 'notice' ? 'form-message notice' : 'form-message'}
            role="alert"
            aria-live="polite"
            hidden={!message}
          >
            {message?.text}
          </div>

          <div class="submit-dock">
            <button
              id="submit-button"
              type={phase === 'editing' ? 'submit' : 'button'}
              disabled={phase === 'submitting' || phase === 'undoing'}
              onClick={phase === 'submitted' ? () => void undo() : undefined}
            >
              <span class="button-label">{SUBMIT_LABELS[phase]}</span>
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}

function afterRender(effect: () => void): void {
  window.setTimeout(effect);
}
