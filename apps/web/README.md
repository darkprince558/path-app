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
| `src/routes/MyMaps.tsx` | `/maps`: your maps (`GET /api/scans/mine`) and maps shared with you (`GET /api/scans/shared`), with All, Public, Unlisted, Private and Shared with me filters. Each card's ⋯ menu offers Copy link, Manage map and Delete… (with a confirmation). |
| `src/routes/ManageMap.tsx` | `/maps/:shareId`: rename, link and QR code, change who can open it, and delete. Only for the map's owner. |
| `src/components/ConfirmDialog.tsx` | Modal confirmation on `<dialog>`: focus starts on Cancel, Escape cancels, focus returns afterward. |
| `src/routes/Community.tsx` | `/community`: public maps from `GET /api/scans/public` with their names, and loading placeholders, empty and error states. |
| `src/lib/session.ts` | Stand-in signed-in account for development (`VITE_DEV_USER`, `VITE_DEV_NAME`) until real sign-in exists. |
| `src/lib/preferences.tsx` | Settings kept on the device (no account needed): text size, motion, and the "Avoid stairs" default. `useTripAvoidStairs` gives each map a per-trip switch that starts from the default and doesn't change it. |
| `src/routes/Settings.tsx` | `/settings`: Text size (Default, Large, Extra large), Motion (Match my device, Reduce, Allow), Avoid stairs by default. |
| `src/routes/Upload.tsx` | `/maps/new` (`/upload` redirects here): an optional name (suggested from the file name), choose a PLY or GLB (checked for type, size and header before sending), pick Public, Unlisted or Private (with viewer IDs), upload with progress and cancel. |
| `src/components/SharePanel.tsx` | After upload: guest link, copy, QR code, preview, and visibility changes through `PATCH /api/scans/<id>`. Warns when the link is `localhost`, which a phone can't open. |
| `src/lib/scans.ts` | Owner API client (upload, sharing) with readable messages for 400, 401, 413, 415 and network failures. |
| `src/routes/GuestView.tsx` | `/s/:shareId` with loading, not-found/denied, download, parse-failure and unsupported-format (GLB) states. |

## Accessibility

- **Keyboard:** "Skip to main content" is the first Tab stop in the app. On a map, Tab order is top bar, then the map, then Avoid stairs and Reset view. With the map focused, the arrow keys turn it (Shift for bigger steps), + and − zoom, and R resets.
- **Focus rings** follow the surface so they stay above 3:1: forest on paper, paper on the forest menu, coral on night. Coral on paper is only 2.2:1, so it is never used for focus there.
- **Text size** scales the root font (everything is in rem). At Extra large, phones show map cards one per row and the map's bottom controls wrap.
- **Reduced motion** follows the device unless Settings overrides it. It turns off CSS animations and the 3D map's glide after letting go.
- **Automated check:** with `pnpm dev` running, open a page and paste this in the browser console to run axe (WCAG 2.x A/AA and best practices):

  ```js
  const s = await (await fetch("/node_modules/axe-core/axe.min.js?raw")).text();
  (0, eval)(s.replace(/^export default /, "window.__axe = ")); (0, eval)(window.__axe);
  (await axe.run(document)).violations
  ```

  On 2026-11-21, `/`, `/maps`, `/community`, `/settings`, `/maps/new` (form and share panel) and `/s/<id>` (map and not-found) returned no violations at 1280x800, and the map also at 375x812 with Extra large text. axe can't measure text over the 3D canvas, so those pairs were checked by hand: sage on night is 9.3:1 and paper on night is 14.6:1.
