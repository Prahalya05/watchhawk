import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import * as authApi from "../api/auth.api";
import { onSessionExpired, TOKEN_KEY } from "../api/client";
import { isAuthExpiry } from "../api/errors";
import type { AuthUser } from "../types";

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  /** Set when a valid-looking session was rejected by the server, so login can explain why. */
  sessionMessage: string | null;
  clearSessionMessage: () => void;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionMessage, setSessionMessage] = useState<string | null>(null);

  const clearSessionMessage = useCallback(() => setSessionMessage(null), []);

  useEffect(() => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      setLoading(false);
      return;
    }
    authApi
      .me()
      .then(setUser)
      .catch((err) => {
        // Only a rejected session is grounds for discarding the token. A backend that is
        // down answers with no response at all, and throwing the token away for that
        // would log the user out every time the server restarts — the request layer has
        // already cleared it for the cases that genuinely warrant it.
        if (isAuthExpiry(err)) {
          setSessionMessage("Your session expired. Please log in again.");
          setUser(null);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  // A 401 on any later request means this session is over; drop the user so the router's
  // RequireAuth sends them to login rather than rendering a dashboard that can't load.
  useEffect(
    () =>
      onSessionExpired(() => {
        setUser(null);
        setSessionMessage("Your session expired. Please log in again.");
      }),
    [],
  );

  async function handleLogin(email: string, password: string) {
    const { user, token } = await authApi.login(email, password);
    localStorage.setItem(TOKEN_KEY, token);
    setSessionMessage(null);
    setUser(user);
  }

  async function handleRegister(email: string, password: string) {
    const { user, token } = await authApi.register(email, password);
    localStorage.setItem(TOKEN_KEY, token);
    setSessionMessage(null);
    setUser(user);
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    setSessionMessage(null);
    setUser(null);
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        sessionMessage,
        clearSessionMessage,
        login: handleLogin,
        register: handleRegister,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
