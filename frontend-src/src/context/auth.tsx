import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  changePassword as apiChangePassword,
  fetchMe,
  login as apiLogin,
  logout as apiLogout,
} from "@/api/endpoints";
import { getStoredToken, onUnauthorized, setStoredToken } from "@/api/client";
import type { User } from "@/api/types";

interface AuthState {
  user: User | null;
  loading: boolean;
  ready: boolean;
}

interface AuthContextValue extends AuthState {
  login: (username: string, password: string) => Promise<User>;
  logout: () => Promise<void>;
  changePassword: (current: string, next: string) => Promise<User>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, loading: false, ready: false });

  const refresh = useCallback(async () => {
    const token = getStoredToken();
    if (!token) {
      setState({ user: null, loading: false, ready: true });
      return;
    }
    setState((prev) => ({ ...prev, loading: true }));
    try {
      const user = await fetchMe();
      setState({ user, loading: false, ready: true });
    } catch {
      setStoredToken(null);
      setState({ user: null, loading: false, ready: true });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    return onUnauthorized(() => {
      setState({ user: null, loading: false, ready: true });
    });
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    setState((prev) => ({ ...prev, loading: true }));
    try {
      const res = await apiLogin(username, password);
      setStoredToken(res.token);
      setState({ user: res.user, loading: false, ready: true });
      return res.user;
    } catch (err) {
      setState((prev) => ({ ...prev, loading: false, ready: true }));
      throw err;
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } catch {
      /* server may already be down; clear local state regardless */
    }
    setStoredToken(null);
    setState({ user: null, loading: false, ready: true });
  }, []);

  const changePassword = useCallback(async (current: string, next: string) => {
    const updated = await apiChangePassword(current, next);
    setState((prev) => ({ ...prev, user: updated }));
    return updated;
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, login, logout, changePassword, refresh }),
    [state, login, logout, changePassword, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
