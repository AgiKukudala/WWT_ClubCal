import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { ApiError, api } from "../api/client";
import { useSession } from "../api/hooks";
import { Alert, Button, Field } from "../components/ui";

function safeNext(next: string | null) {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

function AuthShell({ title, children }: { title: string; children: React.ReactNode }) {
  useEffect(() => {
    document.title = `${title} · ClubCal`;
  }, [title]);
  return (
    <div className="auth-shell">
      <main className="auth-card" id="main">
        <div className="brand big">
          <img src="/favicon.svg" alt="" width={36} height={36} />
          <span>ClubCal</span>
        </div>
        <p className="muted">One shared calendar for every school club.</p>
        <h1>{title}</h1>
        {children}
      </main>
    </div>
  );
}

export function LoginPage() {
  const session = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  if (session.data?.user) return <Navigate to={safeNext(params.get("next"))} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/auth/login", { email, password });
      await qc.resetQueries({ queryKey: ["session"] });
      navigate(safeNext(params.get("next")), { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "x", String(err)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Sign in">
      <form onSubmit={submit} className="stack" noValidate>
        {error && <Alert>{error.message}</Alert>}
        <Field label="School email">
          {(p) => <input {...p} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <Field label="Password">
          {(p) => <input {...p} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <Button variant="primary" type="submit" busy={busy}>
          Sign in
        </Button>
      </form>
      <p className="muted small">
        New here? <Link to="/register">Create a student account</Link>. Forgot your password? Ask a school administrator to reset it.
      </p>
    </AuthShell>
  );
}

export function RegisterPage() {
  const session = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: "", displayName: "", password: "", confirm: "" });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  if (session.data?.user) return <Navigate to="/" replace />;

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const mismatch = form.confirm.length > 0 && form.confirm !== form.password;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mismatch) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/auth/register", {
        email: form.email,
        displayName: form.displayName,
        password: form.password,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      await qc.resetQueries({ queryKey: ["session"] });
      navigate("/clubs", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "x", String(err)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Create your account">
      <form onSubmit={submit} className="stack" noValidate>
        {error && <Alert>{error.message}</Alert>}
        <Field label="Name" error={error?.fields.displayName}>
          {(p) => <input {...p} autoComplete="name" required value={form.displayName} onChange={set("displayName")} />}
        </Field>
        <Field label="School email" error={error?.fields.email}>
          {(p) => <input {...p} type="email" autoComplete="email" required value={form.email} onChange={set("email")} />}
        </Field>
        <Field label="Password" error={error?.fields.password} hint="At least 10 characters.">
          {(p) => <input {...p} type="password" autoComplete="new-password" minLength={10} required value={form.password} onChange={set("password")} />}
        </Field>
        <Field label="Confirm password" error={mismatch ? "Passwords don't match." : undefined}>
          {(p) => <input {...p} type="password" autoComplete="new-password" required value={form.confirm} onChange={set("confirm")} />}
        </Field>
        <Button variant="primary" type="submit" busy={busy} disabled={mismatch}>
          Create account
        </Button>
        <p className="muted small">New accounts are student accounts. Administrators assign club organizer access.</p>
      </form>
      <p className="muted small">
        Already registered? <Link to="/login">Sign in</Link>
      </p>
    </AuthShell>
  );
}
