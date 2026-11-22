#!/usr/bin/env bash
# Not 404 automatic deploy: builds the newest `main` and puts it live on not404.vodka.
# Runs every 2 minutes from not404-deploy.timer; also `systemctl start not404-deploy`.
#
# Website: builds apps/web, then swaps /srv/not404/web (previous build kept in web.prev).
# API (Sam's services/api + Anish's capture processor): builds a release in
#   /srv/not404/releases/api-<sha>, points api-current at it, restarts not404-api and
#   not404-worker, and checks the API answers. If it doesn't, it switches back.
#   A commit that changes services/api/drizzle (database migrations) is NOT deployed:
#   migrations are applied by hand (docs/lidar-publishing.md), so the API waits.
#
# Builds run as the unprivileged not404-api user; root only swaps folders and restarts.
# Logs: journalctl -u not404-deploy.   Live version: https://not404.vodka/VERSION.txt
set -euo pipefail

REPO_URL=https://github.com/darkprince558/path-app.git
BRANCH=main
ROOT=/srv/not404
REPO=$ROOT/repo
STATE=/var/lib/not404-deploy
BUILD_USER=not404-api
ENV_FILE=/etc/not404/api.env
PNPM="corepack pnpm@11.5.2"
KEEP_RELEASES=3

log() { echo "[not404-deploy] $*"; }
as_builder() { runuser -u "$BUILD_USER" -- env HOME=/var/lib/not404 PATH="$PATH" "$@"; }

mkdir -p "$STATE" "$ROOT/releases" "$ROOT/web-builds"
exec 9>"$STATE/lock"
flock -n 9 || { log "another deploy is running"; exit 0; }

if [ ! -d "$REPO/.git" ]; then
  install -d -o "$BUILD_USER" -g "$BUILD_USER" "$REPO"
  as_builder git clone --quiet --branch "$BRANCH" "$REPO_URL" "$REPO"
fi
as_builder git -C "$REPO" fetch --quiet origin "$BRANCH"
NEW=$(as_builder git -C "$REPO" rev-parse "origin/$BRANCH")
SHORT=${NEW:0:8}

# ---------- website ----------
deploy_web() {
  local build="$ROOT/web-builds/$SHORT"
  log "website: building $SHORT"
  rm -rf "$build"; install -d -o "$BUILD_USER" -g "$BUILD_USER" "$build" || return 1
  as_builder sh -c "set -e; git -C '$REPO' archive '$NEW' apps/web > '$build/src.tar'; tar -xf '$build/src.tar' -C '$build'" || return 1
  (cd "$build/apps/web" && as_builder $PNPM install --frozen-lockfile --reporter=silent && as_builder $PNPM build >/dev/null) || return 1
  [ -f "$build/apps/web/dist/index.html" ] || { log "website: build produced no index.html"; return 1; }
  rm -rf "$ROOT/web.new"
  cp -a "$build/apps/web/dist" "$ROOT/web.new" || return 1
  echo "main $SHORT" > "$ROOT/web.new/VERSION.txt"
  chown -R root:root "$ROOT/web.new"; chmod -R a+rX "$ROOT/web.new"
  rm -rf "$ROOT/web.prev"
  [ -d "$ROOT/web" ] && mv "$ROOT/web" "$ROOT/web.prev"
  mv "$ROOT/web.new" "$ROOT/web"
  echo "$NEW" > "$STATE/web.sha"
  log "website: live at $SHORT"
}

# ---------- API ----------
api_healthy() {
  for _ in $(seq 1 30); do
    local public me
    public=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/scans/public || true)
    me=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/users/me || true)
    [ "$public" = 200 ] && [ "$me" = 401 ] && return 0
    sleep 2
  done
  return 1
}

deploy_api() {
  local current_link current release
  current_link=$(readlink -f "$ROOT/api-current" || true)
  current=$(cat "$STATE/api.sha" 2>/dev/null || basename "$current_link" | sed 's/^api-//')
  current=$(as_builder git -C "$REPO" rev-parse --verify --quiet "$current^{commit}" || echo "")
  if [ -n "$current" ] && as_builder git -C "$REPO" diff --quiet "$current" "$NEW" -- services/api apps/capture/processor; then
    echo "$NEW" > "$STATE/api.sha"; log "api: no API changes in $SHORT"; return 0
  fi
  if [ -n "$current" ] && ! as_builder git -C "$REPO" diff --quiet "$current" "$NEW" -- services/api/drizzle; then
    echo "$NEW" > "$STATE/api.pending"
    log "api: $SHORT adds database migrations; NOT deployed. Apply them by hand, then run: rm $STATE/api.pending; echo <applied-sha> > $STATE/api.sha"
    return 0
  fi
  release="$ROOT/releases/api-$SHORT"
  log "api: building $SHORT"
  rm -rf "$release"; install -d -o "$BUILD_USER" -g "$BUILD_USER" "$release" || return 1
  as_builder sh -c "set -e; git -C '$REPO' archive '$NEW' services/api apps/capture/processor > '$release/src.tar'; tar -xf '$release/src.tar' -C '$release'; rm '$release/src.tar'" || return 1
  (cd "$release/apps/capture/processor" && as_builder npm ci --no-audit --no-fund --loglevel=error) || return 1
  (cd "$release/services/api" && as_builder npm ci --no-audit --no-fund --loglevel=error) || return 1
  (cd "$release/services/api" && set -a && . "$ENV_FILE" && set +a && runuser -u "$BUILD_USER" --preserve-environment -- env HOME=/var/lib/not404 npm run build >/dev/null)     || { log "api: build of $SHORT failed; the live API is unchanged"; echo "$NEW" > "$STATE/api.failed"; return 1; }
  local previous="$current_link"
  ln -sfn "$release" "$ROOT/api-current.new" && mv -T "$ROOT/api-current.new" "$ROOT/api-current" || return 1
  systemctl restart not404-api not404-worker || true
  if api_healthy; then
    echo "$NEW" > "$STATE/api.sha"; rm -f "$STATE/api.failed"
    log "api: live at $SHORT"
  else
    log "api: $SHORT failed its health check; rolling back to $(basename "$previous")"
    ln -sfn "$previous" "$ROOT/api-current.new" && mv -T "$ROOT/api-current.new" "$ROOT/api-current"
    systemctl restart not404-api not404-worker
    echo "$NEW" > "$STATE/api.failed"
    api_healthy && log "api: rollback healthy" || log "api: ROLLBACK ALSO UNHEALTHY, check journalctl -u not404-api"
    return 1
  fi
}

status=0
if [ "$(cat "$STATE/web.sha" 2>/dev/null)" != "$NEW" ] && [ "$(cat "$STATE/web.failed" 2>/dev/null)" != "$NEW" ]; then
  if ! deploy_web; then echo "$NEW" > "$STATE/web.failed"; log "website: $SHORT failed to build; the live site is unchanged"; status=1; fi
fi
if [ "$(cat "$STATE/api.sha" 2>/dev/null)" != "$NEW" ] && [ "$(cat "$STATE/api.failed" 2>/dev/null)" != "$NEW" ] \
   && [ "$(cat "$STATE/api.pending" 2>/dev/null)" != "$NEW" ]; then
  deploy_api || status=1
fi

# Keep the newest few builds.
ls -1dt "$ROOT"/web-builds/* 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | xargs -r rm -rf
current_release=$(readlink -f "$ROOT/api-current" || true)
ls -1dt "$ROOT"/releases/api-* 2>/dev/null | grep -vx "$current_release" | tail -n +"$KEEP_RELEASES" | xargs -r rm -rf
exit $status
