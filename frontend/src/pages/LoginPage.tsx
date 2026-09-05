import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { getApiErrorMessage } from "../api/errors";

export default function LoginPage() {
  const { login, user, sessionMessage, clearSessionMessage } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Landing here with a live session (browser back, a bookmarked /login) should not show
  // a login form the user doesn't need.
  useEffect(() => {
    if (user) navigate("/", { replace: true });
  }, [user, navigate]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    clearSessionMessage();
    setSubmitting(true);
    try {
      await login(email, password);
      navigate("/", { replace: true });
    } catch (err) {
      setError(getApiErrorMessage(err, "Couldn't log you in. Please try again."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <h1 className="mb-1 text-xl font-bold text-gray-100">Smart Watchlist</h1>
      <p className="mb-6 text-sm text-gray-500">Log in to your account.</p>
      {sessionMessage && !error && (
        <p className="mb-3 rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-xs text-amber-300">
          {sessionMessage}
        </p>
      )}
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <input
          type="email"
          required
          autoComplete="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100"
        />
        <input
          type="password"
          required
          autoComplete="current-password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100"
        />
        {error && (
          <p className="text-xs text-red-400" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-gray-100 px-3 py-2 text-sm font-medium text-gray-900 hover:bg-white disabled:opacity-50"
        >
          {submitting ? "Logging in…" : "Log in"}
        </button>
      </form>
      <p className="mt-4 text-xs text-gray-500">
        No account?{" "}
        <Link to="/register" className="text-gray-300 underline">
          Register
        </Link>
      </p>
    </div>
  );
}
