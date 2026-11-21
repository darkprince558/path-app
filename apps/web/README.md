# Website

Arielle owns the website: the signed-in home, upload and sharing, and the guest 3D viewer. Build the website here. Start with an upload control, the three visibility choices, a copy-link action and a guest route at `/s/<shareId>`. Display upload, loading and processing failures where they occur.

For the first integration, upload the sample PLY as **Unlisted**, open the returned link in a signed-out session, and use the response’s `assetPath` to load the point cloud with vertex colors. A guest should be able to orbit the scene and recognize the corridor junction. Use the actual phone export to choose camera framing, point size and mobile performance targets.

The local API provides fixture bytes and exercises sharing rules. Replace its test page with the website’s guest route during integration. [Local API commands](../../services/api/README.md) · [Capture format and viewer notes](../../docs/scan-formats.md)

## Run locally

Requires Node 22+ and pnpm. The dev server proxies `/api` to the scan mock on `127.0.0.1:8001`.

```sh
py -3 -B tools/scan_mock.py --port 8001        # from the repo root (or: make dev-api)
cd apps/web && pnpm install && pnpm dev        # http://localhost:5173
```

Open `http://localhost:5173/maps` (Your maps), then **New map** (`/maps/new`), choose `fixtures/venue/scene.ply`, pick a visibility and upload. The page shows the guest link, a copy button and a QR code, and lets you change visibility or private viewers afterwards. You can also upload with the curl command in the [API README](../../services/api/README.md). Then open `http://localhost:5173/s/<shareId>`. The guest page sends no `X-Dev-User` header, so it is a signed-out guest. Owner calls (upload, sharing) send `X-Dev-User: demo-owner` in development only (override with `VITE_DEV_USER`). A production build sends none, because the hosted API reads the signed-in session. `pnpm build` type-checks and writes static files to `dist/`. `pnpm preview` serves them with the same proxy on port 4173. The host must serve `index.html` for `/s/<shareId>`.

| Path | What it does |
| --- | --- |
| `src/index.css` | Color and type tokens from [DESIGN.md](DESIGN.md) as a Tailwind v4 `@theme`. |
| `src/lib/shares.ts` | Calls `GET /api/shares/<id>` and its asset. The API answers 404 both for unknown and for denied shares, so the guest sees one state. |
| `src/lib/ply.ts` | Parses ASCII or binary PLY with `PLYLoader`, rejects empty or non-finite scans, keeps at most 600k points. |
| `src/components/ScanViewer.tsx` | Colored points on `night`, DPR capped at 2, orbit (one finger turns, two fingers zoom and pan), framed from behind the entrance (+Z). Loaded lazily alongside the metadata request. |
| `src/components/AppLayout.tsx` | Signed-in shell: forest sidebar (My maps, Community, New map, account) on desktop, top bar and bottom tab bar on phones. |
| `src/routes/MyMaps.tsx` | `/maps`: Your maps grid with All, Public, Unlisted, Private and Shared with me filters. Shows **sample cards** (`src/lib/maps.ts`) until the API can list an account's maps and their names. |
| `src/routes/Community.tsx` | `/community`: real public maps from `GET /api/scans/public`, with loading, empty and error states. |
| `src/lib/session.ts` | Stand-in signed-in account for development (`VITE_DEV_USER`, `VITE_DEV_NAME`) until real sign-in exists. |
| `src/routes/Upload.tsx` | `/maps/new` (`/upload` redirects here): choose a PLY or GLB (checked for type, size and header before sending), pick Public, Unlisted or Private (with viewer IDs), upload with progress and cancel. |
| `src/components/SharePanel.tsx` | After upload: guest link, copy, QR code, preview, and visibility changes through `PATCH /api/scans/<id>`. Warns when the link is `localhost`, which a phone can't open. |
| `src/lib/scans.ts` | Owner API client (upload, sharing) with readable messages for 400, 401, 413, 415 and network failures. |
| `src/routes/GuestView.tsx` | `/s/:shareId` with loading, not-found/denied, download, parse-failure and unsupported-format (GLB) states. |
