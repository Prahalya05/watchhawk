import { useState, type FormEvent } from "react";
import axios from "axios";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { getApiErrorMessage } from "../api/errors";
import AuthLayout, { AuthField } from "../components/AuthLayout";
import Button from "../components/ui/Button";

export default function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
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
    <AuthLayout
      title="Create an account"
      subtitle="A watchlist that tells you what moved while you were away."
      footer={
        <>
          Already have an account?{" "}
          <Link to="/login" className="text-gray-300 underline hover:text-white">
            Log in
          </Link>
        </>
      }
    >
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
            minLength={8}
            maxLength={72}
            autoComplete="new-password"
            placeholder="At least 8 characters"
            hint="8–72 characters."
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
        <Button type="submit" variant="primary" loading={submitting} className="w-full">
          {submitting ? "Creating account…" : "Register"}
        </Button>
      </form>
    </AuthLayout>
  );
}
