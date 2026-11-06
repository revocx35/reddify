import { type FormEvent, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ApiError, api, setCsrf } from '../api/client';
import { Logo } from '../components/Icon';
import { useAuth } from '../state';

export function LoginPage() {
  const { state, refresh, setMustChangePassword } = useAuth();
  const [params] = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [setupToken, setSetupToken] = useState('');
  const [error, setError] = useState<string | null>(
    params.get('error') === 'oidc' ? 'Sign-in with authentik did not finish. Try again.' : params.get('error') === 'disabled' ? 'This account is disabled.' : null,
  );
  const [busy, setBusy] = useState(false);
  const setup = !!state?.setupNeeded;
  // Only authentik (no local accounts): go straight to it; the user is normally signed in there already.
  const autoOidc = !!state?.oidc.enabled && !state.localLogin && !setup && !params.get('error');
  useEffect(() => {
    if (autoOidc) window.location.assign('/api/auth/oidc/start');
  }, [autoOidc]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = setup ? await api.setup(setupToken, username, password) : await api.login(username, password, needTotp ? totp : undefined);
      setCsrf(r.me.csrf);
      setMustChangePassword(r.mustChangePassword);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'totp_required') setNeedTotp(true);
      else setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-top">
        <Logo size={40} wordmark />
      </div>
      <div className="login-card">
        <h1>{setup ? 'Create the admin account' : 'Log in to Reddify'}</h1>
        {state?.oidc.enabled && !setup ? (
          <>
            <a className="btn btn-big btn-outline" href="/api/auth/oidc/start">
              Continue with {state.oidc.label}
            </a>
            {state.localLogin ? <div className="divider">or</div> : null}
          </>
        ) : null}
        {state?.localLogin || setup ? (
          <form onSubmit={submit} className="form">
            {setup ? (
              <label>
                Setup token
                <input value={setupToken} onChange={(e) => setSetupToken(e.target.value)} autoComplete="off" required />
                <span className="hint">From the server's .env (SETUP_TOKEN), printed by scripts/setup.sh.</span>
              </label>
            ) : null}
            <label>
              Username
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus />
            </label>
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={setup ? 'new-password' : 'current-password'}
                required
                minLength={setup ? 12 : 1}
              />
            </label>
            {needTotp ? (
              <label>
                Code from your authenticator app
                <input value={totp} onChange={(e) => setTotp(e.target.value)} inputMode="numeric" autoComplete="one-time-code" required autoFocus />
              </label>
            ) : null}
            {error ? <p className="form-error">{error}</p> : null}
            <button className="btn btn-big btn-accent" disabled={busy}>
              {setup ? 'Create account' : 'Log In'}
            </button>
          </form>
        ) : error ? (
          <p className="form-error">{error}</p>
        ) : null}
      </div>
    </div>
  );
}

export function ChangePasswordPage() {
  const { setMustChangePassword } = useAuth();
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== again) return setError('The passwords do not match.');
    try {
      await api.changePassword('', next);
      setMustChangePassword(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the password.');
    }
  }
  return (
    <div className="login-page">
      <div className="login-top">
        <Logo size={40} wordmark />
      </div>
      <div className="login-card">
        <h1>Choose your own password</h1>
        <p className="muted">You signed in with a temporary password. Pick a new one (12+ characters).</p>
        <form onSubmit={submit} className="form">
          <label>
            New password
            <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={12} required autoFocus />
          </label>
          <label>
            Repeat it
            <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" minLength={12} required />
          </label>
          {error ? <p className="form-error">{error}</p> : null}
          <button className="btn btn-big btn-accent">Save password</button>
        </form>
      </div>
    </div>
  );
}
