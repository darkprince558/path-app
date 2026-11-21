import { auth0 } from '../lib/auth0';

export default async function Home() {
  const session = await auth0.getSession();

  return (
    <main>
      <h1>Path App</h1>
      {session ? (
        <>
          <p>Logged in as {session.user.email ?? session.user.name ?? session.user.sub}</p>
          <a href="/auth/logout">Log out</a>
        </>
      ) : (
        <>
          <p>Sign in to manage your spaces and scans.</p>
          <a href="/auth/login?screen_hint=signup">Sign up</a>{' '}
          <a href="/auth/login">Log in</a>
        </>
      )}
    </main>
  );
}
