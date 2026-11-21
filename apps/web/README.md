# Website

## Automatic navigation demo

Task 6 adds `/navmesh-demo`: Recast NavMesh generation from a synthetic room,
arbitrary floor picks, agent clearance settings, walkable overlay and doorway
routing. No API is needed. Existing manual navigation and saved routes remain
available. See the [NavMesh runbook](../../docs/navmesh-navigation.md) for local
commands, tests, limits and the approved LiDAR revision integration point.

## Textured GLB spaces and navigation

The integration preserves this React/Vite/Three.js architecture and adds `/spaces`,
`/spaces/:spaceId` and `/events/:eventId` for Sam's Next.js API. The existing
`/s/:shareId` route still supports the legacy mock and now reads GLB as well as PLY.
See the [integration runbook](../../docs/navigation-integration.md) and
[shared coordinate contract](../../docs/scan-data-contract.md).

```sh
cd apps/web
pnpm install --frozen-lockfile
pnpm dev
```

Vite proxies `/api` and `/auth` to `http://127.0.0.1:3000` by default. Run the API
on that address. Use one browser hostname consistently (for example `localhost`).
For Auth0 through Vite, set the API's `APP_BASE_URL=http://localhost:5173` and register
`http://localhost:5173/auth/callback` and the matching logout URL in Auth0. Existing
`localhost:3000` registrations can remain for API-only development. Production needs
one HTTPS origin serving the web build and forwarding `/api` and `/auth` to Next.js.
No client secret or access token is stored by the frontend.

`pnpm test` checks GLB parsing, transforms and routing. `pnpm build` typechecks and
builds the site. `pnpm test:browser` uses the real local API and requires the resource
URLs listed in the runbook. To integrate into Arielle's later frontend branches,
add the three route entries and keep `SpaceViewer` and its API adapter; the newer
map-management, settings and layout branches were not merged here.

## Approved LiDAR scans

Approved revisions appear in the existing space viewer as normal GLBs. Share links
also preserve the saved transform and coordinate metadata; older mock shares keep
their identity-transform fallback. Follow the [Task 5 runbook](../../docs/lidar-publishing.md)
for approval, private/public reads and the synthetic browser test.

## Legacy PLY/mock workflow

Arielle owns the organizer upload flow and guest 3D viewer. Build the website here. Start with an upload control, the three visibility choices, a copy-link action and a guest route at `/s/<shareId>`. Display upload, loading and processing failures where they occur.

For the first integration, upload the sample PLY as **Unlisted**, open the returned link in a signed-out session, and use the response’s `assetPath` to load the point cloud with vertex colors. A guest should be able to orbit the scene and recognize the corridor junction. Use the actual phone export to choose camera framing, point size and mobile performance targets.

The local API provides fixture bytes and exercises sharing rules. Replace its test page with the website’s guest route during integration. [Local API commands](../../services/api/README.md) · [Capture format and viewer notes](../../docs/scan-formats.md)

## Run locally

Requires Node 22+ and pnpm. Set `API_TARGET=http://127.0.0.1:8001` for the legacy mock.

```sh
py -3 -B tools/scan_mock.py --port 8001        # from the repo root (or: make dev-api)
cd apps/web && pnpm install && API_TARGET=http://127.0.0.1:8001 pnpm dev
```

Upload `fixtures/venue/scene.ply` as Unlisted with the curl command in the [API README](../../services/api/README.md), then open `http://localhost:5173/s/<shareId>`. The browser sends no `X-Dev-User` header, so it is a signed-out guest. `pnpm build` type-checks and writes static files to `dist/`. `pnpm preview` serves them with the same proxy on port 4173. The host must serve `index.html` for `/s/<shareId>`.

| Path | What it does |
| --- | --- |
| `src/index.css` | Color and type tokens from [DESIGN.md](DESIGN.md) as a Tailwind v4 `@theme`. |
| `src/lib/shares.ts` | Calls `GET /api/shares/<id>` and its asset. The API answers 404 both for unknown and for denied shares, so the guest sees one state. |
| `src/lib/ply.ts` | Parses ASCII or binary PLY with `PLYLoader`, rejects empty or non-finite scans, keeps at most 600k points. |
| `src/components/ScanViewer.tsx` | Colored points on `night`, DPR capped at 2, orbit (one finger turns, two fingers zoom and pan), framed from behind the entrance (+Z). Loaded lazily alongside the metadata request. |
| `src/routes/GuestView.tsx` | Legacy `/s/:shareId`, PLY or GLB, with loading, denied, download and parse-failure states. |
| `src/routes/SpaceView.tsx` | Accessible Next.js scans and graph, route selection, owner upload/alignment and graph tools. |
| `src/components/SpaceViewer.tsx` | GLTFLoader meshes/materials, combined transformed bounds, graph/route overlays and orbit controls. |
