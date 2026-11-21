# Live deployment plan

The first release succeeds when an organizer uploads a real scan and a guest on a second phone opens the unlisted link and orbits the scene. GitHub hosts the private source, PRs and CI. The proposed runtime is Vultr. Today the repo contains a local sharing mock and a synthetic scene. A hosted URL, durable API, sign-in, mobile viewer and real-device results are pending.

## Proposed runtime

Use one Vultr Cloud Compute VM for Caddy, the built website, the API and PostgreSQL. Store database files on a persistent volume and back them up separately before releases. Keep scan bytes in a private Vultr Object Storage bucket. Configure one team-controlled hostname. Caddy terminates HTTPS, serves the site for `/s/<shareId>`, and forwards `/api/*` to the API. Bind the API and database to the internal network. Open public TCP ports 80/443 and restrict administrative SSH to the team. [Vultr VM setup](https://docs.vultr.com/products/compute/instances/cloud-compute/provisioning) · [Object Storage](https://docs.vultr.com/platform/security-best-practices/vultr-object-storage) · [Caddy HTTPS](https://caddyserver.com/docs/quick-starts/https)

Use Auth0 for organizer and invited-viewer sign-in. Register the HTTPS callback and logout URLs. The backend uses the verified identity from a secure session to grant access. Public scans appear in discovery, unlisted scans open from their opaque link, and private scan reads require the owner or an invited account. Apply that policy to metadata, previews and asset bytes on every request. Disable shared caching for access-controlled reads. The development mock’s `X-Dev-User` header is test-only. [Auth0 sessions](https://auth0.com/blog/application-session-management-best-practices/) · [Path App sharing contract](../services/api/README.md)

## Release order

1. **Krishna and Anish** capture a short corridor, record file size and orientation, and give Sam and Arielle an approved export. Try colored PLY first. Evaluate a self-contained textured GLB on the same phone if the landmark is difficult to recognize. [Capture trial](scan-formats.md)
2. **Sam** builds the durable API. Stream uploads to a generated storage key, enforce a size limit based on the phone trial, and retain format, owner, visibility, grants and upload state in Postgres. Validate the model before publishing the share path. Make finalization retryable and clean up abandoned staged uploads. Serve permitted assets through the API.
3. **Arielle** builds the upload and guest routes against the shared API. Dispatch on the advertised format, support touch controls and show progress and failures. Have a teammate identify the turn on a physical phone before choosing the export preset. [Web workspace](../apps/web/README.md)
4. **Anish and Sam** choose a hostname, region and spend limit before provisioning. Point the DNS A record at the VM. Store the application origin, database connection, session secret, Auth0 credentials, object endpoint, bucket and storage keys as runtime configuration. Keep secret values out of Git, browser builds and agent checkpoints. Add the Gemini key server-side when its feature ships.
5. **Sam and Arielle** package their API and web build from the same reviewed GitHub commit. Record its SHA, apply database migrations and start the release behind Caddy. Verify an API health check, HTTPS certificate and a direct reload of a guest URL. Keep the previous release and a database backup available.

## Acceptance and recovery

- Upload the real scan as **Unlisted**, copy its HTTPS link, and open it signed out on a second phone over cellular. Record seconds to first interactive view, whether touch orbit works, and whether the visitor recognizes the landmark.
- Restart the API and database and reload that same link. Change to **Public** and confirm discovery. Switch to **Private** and confirm it disappears. An invited account can still load the bytes. After revocation, its next metadata and asset requests must both be denied.
- Record the tested commit, devices, file size, timings and outcome in the release PR. If the release fails, restore the previous build and rerun the share test. Keep migrations backward-compatible for rollback. If data recovery is necessary, restore the backup separately and verify it before switching traffic.
- After judging, confirm who owns ongoing costs and how long demo scans should remain available. On retirement, export the data the team wants to retain, then remove the VM, allocated storage and unused credentials and check the provider’s billing dashboard.
