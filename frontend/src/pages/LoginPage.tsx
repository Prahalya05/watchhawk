import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { getApiErrorMessage } from "../api/errors";
import AuthLayout, { AuthField } from "../components/AuthLayout";
import Button from "../components/ui/Button";

export default function LoginPage() {
  const { login, user, sessionMessage, clearSessionMessage } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
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
    <AuthLayout
      title="Welcome back"
      subtitle="Log in to your account."
      footer={
        <>
          No account?{" "}
          <Link to="/register" className="text-gray-300 underline hover:text-white">
            Register
          </Link>
        </>
      }
    >
      {sessionMessage && !error && (
        <p className="mb-3 rounded-lg border border-hairline border-l-2 border-l-severity-notable bg-severity-notable/5 px-3 py-2 text-xs text-severity-notable">
          {sessionMessage}
        </p>
      )}
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <AuthField
          label="Email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <div className="relative">
          <AuthField
            label="Password"
            type={showPassword ? "text" : "password"}
            required
            autoComplete="current-password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            className="absolute right-3 top-[30px] text-[11px] font-medium text-gray-500 hover:text-gray-300"
          >
            {showPassword ? "Hide" : "Show"}
          </button>
        </div>
        {error && (
          <p className="text-xs text-severity-critical" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" loading={submitting} className="w-full">
          {submitting ? "Logging in…" : "Log in"}
        </Button>
      </form>
    </AuthLayout>
  );
}
