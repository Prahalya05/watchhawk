import { useState, type FormEvent } from "react";
import axios from "axios";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { getApiErrorMessage } from "../api/errors";

export default function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Only a genuine 409 offers the "log in instead" shortcut — the old page implied it
  // on every failure, including a backend that wasn't running.
  const [emailTaken, setEmailTaken] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setEmailTaken(false);
    setSubmitting(true);
    try {
      await register(email, password);
      navigate("/", { replace: true });
    } catch (err) {
      setEmailTaken(axios.isAxiosError(err) && err.response?.status === 409);
      setError(getApiErrorMessage(err, "Couldn't create your account. Please try again."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <h1 className="mb-1 text-xl font-bold text-gray-100">Smart Watchlist</h1>
      <p className="mb-6 text-sm text-gray-500">Create an account.</p>
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
          minLength={8}
          maxLength={72}
          autoComplete="new-password"
          placeholder="Password (min 8 characters)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100"
        />
        {error && (
          <p className="text-xs text-red-400" role="alert">
            {error}
            {emailTaken && (
              <>
                {" "}
                <Link to="/login" className="underline">
                  Go to log in
                </Link>
              </>
            )}
          </p>
        )}
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-gray-100 px-3 py-2 text-sm font-medium text-gray-900 hover:bg-white disabled:opacity-50"
        >
          {submitting ? "Creating account…" : "Register"}
        </button>
      </form>
      <p className="mt-4 text-xs text-gray-500">
        Already have an account?{" "}
        <Link to="/login" className="text-gray-300 underline">
          Log in
        </Link>
      </p>
    </div>
  );
}
