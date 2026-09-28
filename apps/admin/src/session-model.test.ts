import { describe, expect, it, vi } from 'vitest';
import { createSessionModel, type SessionDependencies } from './session-model.ts';

function dependencies(overrides: Partial<SessionDependencies> = {}): SessionDependencies {
  return {
    hasSession: () => false,
    adminLogin: async () => 'token',
    saveSession: () => undefined,
    clearSession: () => undefined,
    onSignedIn: () => undefined,
    onSignedOut: () => undefined,
    ...overrides
  };
}

describe('createSessionModel', () => {
  it('requires credentials', async () => {
    const adminLogin = vi.fn(async () => 'token');
    const session = createSessionModel(dependencies({ adminLogin }));
    session.setIdentifier(' ');
    await session.login();
    expect(session.state.value.error).toBe('Enter your RTO number or email and password.');
    expect(adminLogin).not.toHaveBeenCalled();
  });

  it('saves the session and clears the password after signing in', async () => {
    const saveSession = vi.fn();
    const onSignedIn = vi.fn();
    const session = createSessionModel(dependencies({ saveSession, onSignedIn }));
    session.setIdentifier(' 12345 ');
    session.setPassword('secret');
    await session.login();
    expect(saveSession).toHaveBeenCalledWith('token');
    expect(onSignedIn).toHaveBeenCalledOnce();
    expect(session.state.value).toMatchObject({ signedIn: true, identifier: ' 12345 ', password: '' });
  });

  it('reports a failed sign-in', async () => {
    const session = createSessionModel(
      dependencies({
        adminLogin: async () => {
          throw new Error('Wrong password.');
        }
      })
    );
    session.setIdentifier('12345');
    session.setPassword('secret');
    await session.login();
    expect(session.state.value).toMatchObject({ signedIn: false, signingIn: false, error: 'Wrong password.' });
  });

  it('clears the session when signing out', () => {
    const clearSession = vi.fn();
    const onSignedOut = vi.fn();
    const session = createSessionModel(dependencies({ hasSession: () => true, clearSession, onSignedOut }));
    session.signOut('Sign in again.');
    expect(clearSession).toHaveBeenCalledOnce();
    expect(onSignedOut).toHaveBeenCalledOnce();
    expect(session.state.value).toMatchObject({ signedIn: false, error: 'Sign in again.' });
  });
});
