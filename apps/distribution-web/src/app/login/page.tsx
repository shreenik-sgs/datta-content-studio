export default async function Login({
  searchParams,
}: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="shell">
      <h1>Sign in to Datta Content Studio</h1>
      <p>Use your Content Studio account.</p>
      {error && (
        <p role="alert">
          Unable to sign in. Check your details, or wait 15 minutes if you have tried repeatedly.
        </p>
      )}
      <form className="card" method="post" action="/distribution/api/auth/login">
        <label>
          Email
          <input name="email" type="email" autoComplete="username" required maxLength={254} />
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
    </main>
  );
}
