# React authentication and not404.vodka deployment

Human owner: Sam. Frontend reviewer: Arielle. Scope: `apps/web`, the existing API identity response and start command, and this deployment runbook. Success: a real account signs in through the backend, opens My maps, refreshes, signs out, and a signed-out guest still opens an authorized public/unlisted map.

## Implementation and branch

`feature/auth0-frontend-integration` starts at `d1bcf19`, the fetched tip of `origin/feature/integrate-lidar` containing Arielle’s branded website and Sam’s API/CPU integration (PR #36). The original worktree and branches were preserved. After the integrated LiDAR commit reached `main` through PR #41, this branch merged `origin/main` at `d093d5b` with a normal merge. The merge also preserves the viewer polish, branding and Gemini changes from main.

The installed server SDK is `@auth0/nextjs-auth0` **4.33.0**. `src/proxy.ts` delegates to it; its routes are `/auth/login`, `/auth/logout`, `/auth/callback`, `/auth/profile`. The browser access-token endpoint is disabled. The React app installs no Auth0 SDK and stores no tokens. Sign-in/out use full-page links, with a local `returnTo` after login and `/` after logout.

`AuthProvider` / `useAuth` in `apps/web/src/lib/auth.tsx` read **`/api/users/me`**, which already verifies the backend session/API audience and returns the database user UUID. This is preferable to `/auth/profile` for comparing `space.ownerId`. No `/api/auth/me` duplicate is needed. Identity responses now carry `Cache-Control: no-store`. API authentication still accepts either the session cookie (including server-side access-token validation) or a bearer token. Owner, viewer and asset authorization rules are unchanged.

`/maps`, `/maps/new`, `/maps/:shareId` require the account check before mounting. Loading, anonymous and retry states are explicit. API 401s clear React identity and offer sign-in; no automatic redirect interrupts public browsing. Space creation, owner tools and saved routes use the same account context. Community, guest shares and public spaces remain readable without sign-in, including when account discovery fails. Refocusing the window rechecks identity. Refresh retrieves the backend session again; there is no local-storage login flag. The former demo account and `X-Dev-User` frontend headers are removed; the Python mock remains a fixture-only HTTP tool.

## VM inspection status

**Blocked awaiting connection details, not inspected.** Local `~/.ssh/config` contains only an unrelated university host alias. No SSH agent is available. A `~/.ssh/vultr` key file exists, but its destination and username are unknown. No private keys were read. Sam must supply the VM alias or username/host/key path (paths only, never key contents). No connection or production changes have been attempted.

Ubuntu version, Node version, deployed revision/root, Caddy configuration, API/process manager, environment sources, port 3000 and capture-worker status are all **unverified**. Do not treat the proposed paths below as discovered configuration.

Once SSH is identified, inspect read-only:

```sh
ssh <confirmed-alias>
cat /etc/os-release
node --version
command -v node npm pnpm caddy
sudo ss -ltnp 'sport = :3000'
systemctl list-units --type=service --all --no-pager
pm2 list  # only if installed
sudo cat /etc/caddy/Caddyfile  # inspect privately; redact credentials if present
```

Identify the API/frontend/worker service names and inspect unit **file paths, working directories, executable paths and EnvironmentFile paths**. Do not print environment values, `pm2 env`, process environments, private keys or credential-bearing command lines into agent logs. Report required variable names as set/missing and report only `APP_BASE_URL`/audience/origin values. Inspect deployed Git SHA and frontend directory. Check worker active/failed status and persistent storage paths without restarting anything. Keep `CAPTURE_PROCESSOR`, CPU executable, database and capture/revision/scan storage configuration intact.

## Auth0 Dashboard: Sam’s account action

In Auth0 Dashboard → Applications → Applications, open the **existing Regular Web Application** identified by the backend `AUTH0_CLIENT_ID`. Under Settings, append these values, preserving existing local registrations:

| Setting | Production value |
| --- | --- |
| Allowed Callback URLs | `https://not404.vodka/auth/callback` |
| Allowed Logout URLs | `https://not404.vodka` |
| Allowed Web Origins | `https://not404.vodka` |

Save Changes. Under APIs, use the existing identifier **`https://api.not404.app`**, RS256, and existing application authorization for user-delegated access. Do not rename the audience to match the new website domain. Verify the required login connections are enabled for this same application. Do not create an SPA application or copy a client secret into Vite variables. Dashboard values are not verified by a successful `/auth/login` redirect; complete the real callback to confirm them.

Official references: [SDK v4](https://auth0.github.io/nextjs-auth0/), [Caddy SPA and API pattern](https://caddyserver.com/docs/caddyfile/patterns#single-page-apps-spas).

## Backend environment and HTTPS

Keep the existing server-only `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_SECRET`, `DATABASE_URL` and storage/worker configuration. Set only the public origin to `APP_BASE_URL=https://not404.vodka`; preserve `AUTH0_AUDIENCE=https://api.not404.app`. Keep the existing session secret stable across releases and instances. Do not regenerate it on deployment. The SDK infers Secure cookies from the HTTPS base URL; retain HttpOnly, SameSite=Lax and host-only cookies. Remove any conflicting insecure cookie override only after inspecting it and obtaining approval for the environment change. Never set secrets as `VITE_*` or `NEXT_PUBLIC_*`.

Caddy forwards `/api/*` and `/auth/*` to loopback, preserving their prefixes. Use `handle`, not `handle_path` (which strips them). The fallback serves the React build with SPA routing. [Proposed site block](../deploy/auth0/Caddyfile.example) assumes `/srv/not404/current`; adapt it to the inspected deployment. Preserve all other domains/routes/limits. Forwarding all API requests through Next’s proxy retains rolling session behavior. `npm start` now explicitly binds **127.0.0.1:3000**.

Node **22** is sufficient for both packages (local verification used 22.23.2). If the VM lacks it, agree on installation commands after inspecting Ubuntu and its existing Node/process-manager setup. Installing or changing Node on the VM requires approval; do not replace a runtime used by the capture worker implicitly.

## Local checks and real login

Use Node 22+. Install locked dependencies independently in `services/api`, `apps/web`, and the capture processor (the latter is required by existing API contract tests):

```sh
cd apps/capture/processor
npm ci
cd ../../../services/api
npm ci
# Configure .env.local privately from .env.local.example.
# For Vite: APP_BASE_URL=http://localhost:5173
npm run dev
# In a second terminal:
cd apps/web
pnpm install --frozen-lockfile
pnpm dev
```

Register `http://localhost:5173/auth/callback` and `http://localhost:5173` in the same Auth0 application for local login. Keep browser hostname `localhost` consistent. Vite already proxies both `/api` and `/auth` to 127.0.0.1:3000.

Checks, from the repository root:

```sh
make check
cd apps/web
npm run typecheck
npm test
npm run build
npm run test:auth:browser
cd ../../services/api
npm run typecheck
# Supply server Auth0 environment privately; synthetic values suffice for unit tests.
npm test
npm run build
```

The browser suite starts Vite on 127.0.0.1:5190 with synthetic account/API responses. It checks owner route guards and return destinations, cookies/identity across reload, backend logout link and simulated cookie removal, owner 401 invalidation, retry, public discovery and loading controls. It does **not** test real Auth0 credentials, callback exchange or real database-backed scan lists.

After merging `origin/main` at `d093d5b`, local verification on 2026-11-21 (Toronto): both typechecks/builds passed; 25 frontend unit tests passed; 7 auth browser tests passed; API 28 passed / 13 database tests skipped because no disposable database was configured. `make check` passed public/unlisted/private, grants/revocation and raw assets using the synthetic venue fixture. Existing large frontend chunk warnings remain.

A separately started production API build on local port 5191, with public production origin and synthetic secrets/unreachable database, returned anonymous 401 for `/api/users/me`, `/api/scans/mine`, `/api/scans/shared`, `/auth/profile`. `/auth/login?returnTo=%2Fmaps` returned 307 to the existing Auth0 tenant with the exact production callback and audience; transaction cookie flags were Secure, HttpOnly, SameSite=Lax. Logout returned 307 to Auth0 OIDC logout and expired the local session cookie. No authorization code was exchanged and no production database was contacted.

## Deployment commands: approval gate

**Do not run this section until VM inspection, Dashboard confirmation, and Sam’s explicit approval.** Exact live paths/service names remain blocked on SSH details. The following commands describe a proposed layout; substitute inspected values and present the final command list for approval. Never replace the live checkout or build in its active directory. No migration, seed, firewall or worker restart is part of this auth release.

Stage from the committed branch in a new release directory (on the VM or a matching Linux build host), preserving the old release:

```sh
# Set these to confirmed paths and the reviewed commit after inspection.
REPO=/srv/not404/repo
RELEASE=/srv/not404/releases/<reviewed-commit>
git -C "$REPO" fetch origin feature/auth0-frontend-integration
git -C "$REPO" worktree add --detach "$RELEASE" <reviewed-commit>
cd "$RELEASE/services/api"
npm ci
# Load the inspected existing environment privately for build/runtime.
# Never copy an example over the production environment file.
npm run typecheck
npm run build
cd "$RELEASE/apps/web"
pnpm install --frozen-lockfile
npm run build
```

Configure the existing API service/process manager to run the new release with its existing environment source and Node 22 executable. Its command is `npm start` in `services/api`. Preserve the worker’s working directory/release and all persistent absolute storage paths; relative default storage paths would otherwise move with a release. If there is no API service, prepare a unit for review first with a non-root service account, confirmed environment path and working directory. Do not invent a second live process on occupied port 3000.

Merge the proposed Caddy block into a candidate file containing all existing sites. Validation and the approval-only cutover, for a confirmed systemd deployment:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile.candidate --adapter caddyfile
# Record the old current target and preserve the existing Caddyfile before cutover.
readlink -f /srv/not404/current
sudo cp -a /etc/caddy/Caddyfile /etc/caddy/Caddyfile.before-auth0
sudo ln -s "$RELEASE" /srv/not404/current.auth0-next
sudo mv -Tf /srv/not404/current.auth0-next /srv/not404/current
# Install only the approved merged candidate, never overwrite secrets.
sudo install -m 644 /etc/caddy/Caddyfile.candidate /etc/caddy/Caddyfile
sudo systemctl restart <confirmed-api-unit>
sudo systemctl reload caddy
```

These service/cutover commands need explicit approval. For PM2 or another layout, replace them with its inspected commands and seek approval on that concrete list. Caddy configuration validation on the VM remains pending (Caddy is not installed locally). If rollback is needed, obtain approval to repoint `current` to the recorded prior release, restore the preserved Caddyfile and restart only the API/reload Caddy. Leave database and worker untouched.

## Real browser acceptance: local first, production after approval

1. Fresh signed-out browser: open `/`, `/community` and a known public and unlisted share. Verify scene bytes and orbit; a private share must remain denied.
2. Open `/maps`: sign-in prompt appears. Click Sign in, complete Auth0, return to `/maps`; repeat from a deep owner URL and check its return path.
3. Verify real account name and `/api/users/me` 200. `/api/scans/mine` must return 200 from the cookie alone, with no Authorization or development header. Refresh and verify the same identity and maps.
4. Verify an owned map can be managed, and another account cannot edit it. Open a granted private map as its invitee; verify a stranger cannot fetch metadata or raw bytes. Do not mutate production sharing without approval; use an approved test map.
5. Sign out: return to `/`; reload `/maps` and verify sign-in is required. Requests to `/api/users/me` and `/api/scans/mine` return 401. Public and unlisted views continue working. Simulate an expired session and verify the protected page offers sign-in.
6. Repeat on `https://not404.vodka` after deployment approval. Record commit, browser/device, account roles, approved fixture IDs and observed results without storing cookies/tokens. Confirm real session cookies are Secure/HttpOnly/SameSite=Lax and the callback origin is HTTPS.

Outstanding: SSH/VM inspection, Dashboard settings, real local Auth0 login with database-backed maps, real granted/private account checks, Caddy validation, approved deployment, production flow and second-phone test.
