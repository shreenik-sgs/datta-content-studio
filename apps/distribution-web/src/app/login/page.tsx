import { studioTestLoginAliases } from "../../lib/auth";

export default async function Login({
  searchParams,
}: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const aliasesEnabled = Object.keys(studioTestLoginAliases()).length > 0;
  return (
    <main className="shell studio-login">
      <div className="studio-login-card">
        <p className="eyebrow">Create with purpose</p>
        <h1>Sign in to Datta Content Studio</h1>
        <p className="muted">Your workspace for curation, review and publishing.</p>
        {error && (
          <p className="notice error" role="alert">
            Unable to sign in. Check your details, or wait 15 minutes if you have tried repeatedly.
          </p>
        )}
        <form className="card" method="post" action="/distribution/api/auth/login">
          <label>
            {aliasesEnabled ? "Username or email" : "Email"}
            <input
              name="email"
              type={aliasesEnabled ? "text" : "email"}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              maxLength={254}
            />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={256}
            />
          </label>
          <button className="button primary" type="submit">
            Sign in
          </button>
        </form>
      </div>
    </main>
  );
}
