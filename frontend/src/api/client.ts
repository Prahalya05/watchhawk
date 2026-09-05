import axios from "axios";
import { isAuthExpiry } from "./errors";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000/api";

export const TOKEN_KEY = "watchlist_token";

export const apiClient = axios.create({
  baseURL: API_URL,
  // Without a timeout, axios waits forever. A backend that accepts the connection but
  // never answers would leave the login button stuck on "Logging in…" with nothing on
  // screen to explain it.
  timeout: 15000,
});

apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Listeners registered by AuthContext, so a session that dies mid-use (expired token,
// deleted account, restarted server with a new JWT_SECRET) clears state and routes back
// to login instead of leaving the dashboard mounted and quietly failing every refetch.
const sessionExpiredHandlers = new Set<() => void>();

export function onSessionExpired(handler: () => void): () => void {
  sessionExpiredHandlers.add(handler);
  return () => sessionExpiredHandlers.delete(handler);
}

// The login and register calls legitimately answer 401/409 for bad input; treating those
// as a dying session would wipe a token the user may still hold from another tab.
const AUTH_ENTRY_PATHS = ["/auth/login", "/auth/register"];

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    const url = error?.config?.url ?? "";
    const isEntryCall = AUTH_ENTRY_PATHS.some((p) => url.includes(p));
    if (!isEntryCall && isAuthExpiry(error)) {
      localStorage.removeItem(TOKEN_KEY);
      for (const handler of sessionExpiredHandlers) handler();
    }
    return Promise.reject(error);
  },
);
