import { signal } from '@preact/signals';

export interface SessionState {
  readonly signedIn: boolean;
  readonly identifier: string;
  readonly password: string;
  readonly signingIn: boolean;
  readonly error: string | undefined;
}

export interface SessionDependencies {
  readonly hasSession: () => boolean;
  readonly adminLogin: (identifier: string, password: string) => Promise<string>;
  readonly saveSession: (token: string) => void;
  readonly clearSession: () => void;
  readonly onSignedIn: () => void;
  readonly onSignedOut: () => void;
}

export type SessionModel = ReturnType<typeof createSessionModel>;

export function createSessionModel(dependencies: SessionDependencies) {
  const state = signal<SessionState>({
    signedIn: dependencies.hasSession(),
    identifier: '',
    password: '',
    signingIn: false,
    error: undefined
  });

  function update(patch: Partial<SessionState>): void {
    state.value = { ...state.value, ...patch };
  }

  function setIdentifier(identifier: string): void {
    update({ identifier });
  }

  function setPassword(password: string): void {
    update({ password });
  }

  async function login(): Promise<void> {
    const identifier = state.value.identifier.trim();
    const { password } = state.value;
    update({ error: undefined });
    if (!identifier || !password) {
      update({ error: 'Enter your RTO number or email and password.' });
      return;
    }
    update({ signingIn: true });
    try {
      dependencies.saveSession(await dependencies.adminLogin(identifier, password));
      update({ signedIn: true, password: '', signingIn: false });
      dependencies.onSignedIn();
    } catch (error) {
      update({ signingIn: false, error: error instanceof Error ? error.message : 'Sign-in failed.' });
    }
  }

  function signOut(error?: string): void {
    dependencies.clearSession();
    update({ signedIn: false, password: '', error });
    dependencies.onSignedOut();
  }

  return { state, setIdentifier, setPassword, login, signOut };
}
