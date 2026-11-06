import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import type { AuthState, Me } from '../../shared/api';
import { api, setCsrf, setUnauthorizedHandler } from './api/client';
import { player } from './player/player';

interface AuthCtx {
  state: AuthState | null;
  me: Me | null;
  loading: boolean;
  failed: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  mustChangePassword: boolean;
  setMustChangePassword: (v: boolean) => void;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [mustChangePassword, setMustChangePassword] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const s = await api.state();
      setCsrf(s.me?.csrf ?? '');
      setState(s);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    setUnauthorizedHandler(() => void refresh());
  }, [refresh]);

  const logout = useCallback(async () => {
    const r = await api.logout().catch(() => null);
    player.audio.pause();
    setCsrf('');
    await refresh();
    if (r?.providerLogout) window.location.href = r.providerLogout;
  }, [refresh]);

  return (
    <Ctx.Provider value={{ state, me: state?.me ?? null, loading, failed, refresh, logout, mustChangePassword, setMustChangePassword }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('AuthProvider missing');
  return c;
}
