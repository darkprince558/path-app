# Automatic deploys to not404.vodka

Every 2 minutes the server checks `main` on GitHub. When there's a new commit, it builds it and puts it live. Merging a PR into `main` is all it takes. A deploy usually finishes 3–5 minutes after the merge.

| Part | What happens | If it fails |
| --- | --- | --- |
| Website (`apps/web`) | Builds with pnpm in `/srv/not404/web-builds/<sha>`, then swaps it into `/srv/not404/web`. The previous build stays in `web.prev`. | The live site is unchanged. That commit isn't retried. |
| API (`services/api` + `apps/capture/processor`) | Only when those folders changed. Builds `/srv/not404/releases/api-<sha>`, points `api-current` at it, restarts `not404-api` and `not404-worker`, then checks that `/api/scans/public` answers 200 and `/api/users/me` answers 401. | Switches `api-current` back to the previous release and restarts. That commit isn't retried. |
| Database migrations | A commit that changes `services/api/drizzle` is **not** deployed to the API, because migrations are applied by hand (`docs/lidar-publishing.md`). The website still deploys. | Apply the migration, then `echo <sha> > /var/lib/not404-deploy/api.migrated && rm /var/lib/not404-deploy/api.pending` (the log line names the SHA). The next run deploys the API, and so does any later commit with the same migrations. |

Builds run as the unprivileged `not404-api` user. Root only swaps folders and restarts the two services. Server secrets stay in `/etc/not404/api.env`, which is read only for the API build.

## Check and control it

```sh
ssh root@155.138.139.241
journalctl -u not404-deploy -n 50          # what the last runs did
systemctl list-timers not404-deploy.timer  # when it runs next
systemctl start not404-deploy              # deploy now, without waiting
cat /var/lib/not404-deploy/{web,api}.sha   # what's live
systemctl disable --now not404-deploy.timer   # pause automatic deploys
```

The website's live version is at https://not404.vodka/VERSION.txt.

**Roll back the website:** `mv /srv/not404/web /srv/not404/web.bad && mv /srv/not404/web.prev /srv/not404/web`.

**Roll back the API:** `ln -sfn /srv/not404/releases/api-<old-sha> /srv/not404/api-current.new && mv -T /srv/not404/api-current.new /srv/not404/api-current && systemctl restart not404-api not404-worker`.

After a manual rollback, pause the timer too, or the next new commit deploys again.

## Install (already done on the server)

```sh
install -m 755 deploy/auto/not404-deploy.sh /usr/local/bin/not404-deploy
cp deploy/auto/not404-deploy.service deploy/auto/not404-deploy.timer /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now not404-deploy.timer
```

It pulls the public repository over HTTPS, so no GitHub secrets or deploy keys are needed. If the repo goes private again, add a read-only deploy key and switch `REPO_URL` to SSH.
