import axios from "axios";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000/api";

// Server error codes the UI has something specific to say about. Anything else falls
// through to a status-based message rather than being guessed at.
const MESSAGES: Record<string, string> = {
  EMAIL_TAKEN: "An account with that email already exists. Log in instead.",
  INVALID_CREDENTIALS: "Incorrect email or password.",
  INVALID_JSON: "The app sent a malformed request. Please reload the page.",
  MISSING_TOKEN: "You're not signed in.",
  TOKEN_EXPIRED: "Your session expired. Please log in again.",
  INVALID_TOKEN: "Your session is no longer valid. Please log in again.",
  USER_NOT_FOUND: "That account no longer exists.",
  UNKNOWN_SYMBOL: "That symbol isn't in the tracked universe.",
  ALREADY_WATCHED: "That symbol is already on your watchlist.",
  NOT_WATCHED: "That symbol isn't on your watchlist.",
};

interface ApiErrorBody {
  error?: string;
  details?: { fieldErrors?: Record<string, string[] | undefined> };
}

/**
 * Turns any thrown request failure into a message that describes what actually went
 * wrong. The register and login screens used to report every failure as "that email may
 * already be taken", so a backend that was simply not running read as a duplicate
 * account — the one explanation the user could do nothing about and had no reason to
 * believe. Distinguishing "no response at all" from a real 4xx is the whole point.
 */
export function getApiErrorMessage(err: unknown, fallback = "Something went wrong. Please try again."): string {
  if (!axios.isAxiosError(err)) return fallback;

  // No response: the request never reached a server. Connection refused, DNS failure,
  // CORS rejection, or the dev server pointing at the wrong port.
  if (!err.response) {
    if (err.code === "ECONNABORTED") return "The server took too long to respond. Please try again.";
    return `Can't reach the server at ${API_URL}. Make sure the backend is running (npm run dev in backend/).`;
  }

  const body = err.response.data as ApiErrorBody | undefined;
  const code = typeof body?.error === "string" ? body.error : undefined;

  // Field-level validation beats a generic message: "Password must be at least 8
  // characters" is actionable where "invalid request" is not.
  if (code === "INVALID_BODY") {
    const fieldErrors = body?.details?.fieldErrors ?? {};
    const first = Object.values(fieldErrors).flat().filter(Boolean)[0];
    if (first) return first;
    return "Please check the details you entered.";
  }

  if (code && MESSAGES[code]) return MESSAGES[code];

  switch (err.response.status) {
    case 401:
      return "Please log in again.";
    case 403:
      return "You don't have access to that.";
    case 404:
      return "That endpoint wasn't found on the server.";
    case 429:
      return "Too many requests. Please wait a moment and try again.";
    default:
      if (err.response.status >= 500) return "The server hit an error. Please try again in a moment.";
      return fallback;
  }
}

/** True when the failure is an expired or otherwise unusable session token. */
export function isAuthExpiry(err: unknown): boolean {
  if (!axios.isAxiosError(err) || err.response?.status !== 401) return false;
  const code = (err.response.data as ApiErrorBody | undefined)?.error;
  return code === "TOKEN_EXPIRED" || code === "INVALID_TOKEN" || code === "MISSING_TOKEN" || code === "USER_NOT_FOUND";
}
