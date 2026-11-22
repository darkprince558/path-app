# Website

Arielle owns the website: the signed-in home, upload and sharing, and the guest 3D viewer. Build the website here. Start with an upload control, the three visibility choices, a copy-link action and a guest route at `/s/<shareId>`. Display upload, loading and processing failures where they occur.

## Authentication

The existing Next.js backend owns Auth0. React uses `AuthProvider` / `useAuth` and `/api/users/me`, with full-page Sign in / Sign out links. My maps and owner pages require a verified session; Community and authorized guest views work signed out. API requests use same-origin cookies and clear account state on 401. No frontend SDK, tokens or secrets are needed. Run `npm run test:auth:browser` for synthetic browser coverage. See the [production setup and real-login checklist](../../docs/auth0-production.md).

## Automatic routes from approved scans

After a GLB upload, choose **Plan a route**. Shared GLB viewers build a walkable
floor automatically: double-click or double-tap a start and destination to draw a
route, then expand **Step-by-step directions** for relative turns and distances.
Single uploads use glTF's metre/+Y convention and label unverified scale; explicitly
relative models still need calibration. Multi-scan spaces retain verified alignment
requirements and opt-in automatic routing. Manual graph and saved routes remain
available when the mode is off. See the [full workflow and tests](../../docs/scan-automatic-routing.md).

Calibration follows validated native capture provenance. To repair an old approved
scan, use **Owner tools → Upload and align scans → Restore validated LiDAR calibration**.
Scale and alignment confirmations are separate for imports and mocks. See the
[calibration runbook](../../docs/scan-calibration.md).

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
URLs listed in the runbook.

## Approved LiDAR scans

Approved revisions appear in the existing space viewer as normal GLBs. Share links
also preserve the saved transform and coordinate metadata; older mock shares keep
their identity-transform fallback. Follow the [Task 5 runbook](../../docs/lidar-publishing.md)
for approval, private/public reads and the synthetic browser test.

For the first integration, upload the sample PLY as **Unlisted**, open the returned link in a signed-out session, and use the response’s `assetPath` to load the point cloud with vertex colors. A guest should be able to orbit the scene and recognize the corridor junction. Use the actual phone export to choose camera framing, point size and mobile performance targets.

The local API provides fixture bytes and exercises sharing rules. Replace its test page with the website’s guest route during integration. [Local API commands](../../services/api/README.md) · [Capture format and viewer notes](../../docs/scan-formats.md)

## Map-card pictures

Map cards show a picture of the scan. The first time the owner opens a 3D map that has none,
`GuestView` asks `lib/thumbnails.ts` whether one is needed (a 404 from
`/api/shares/<shareId>/thumbnail`, and the map is in `/api/scans/mine`), and `SpaceViewer`
renders one 480 × 288 JPEG from its own steep, floor-plan-like camera fitted to the scan's
points. The user's view isn't touched. Cards without a picture keep the stylized dot preview.
Locally: run the mock with `--signed-in-as <name>` so the website counts as signed in.

## Filling holes before upload

`tools/scan_fill_holes.py` patches small holes in a phone scan GLB and removes floating
fragments, then writes a new GLB the website shows like any Path Capture scan. It rebuilds
the surface with screened Poisson reconstruction and keeps only new surface within
`--max-gap` metres (default 0.12) of the real scan, so doorways and open ends are not
walled over. Needs `pip install open3d numpy` (Python 3.10–3.12).

```
python tools/scan_fill_holes.py hallway.glb hallway-filled.glb
python tools/scan_fill_holes.py hallway.glb hallway-filled.glb --max-gap 0.2 --max-triangles 800000
```

On a 1.37M-triangle, 37 MB hallway scan it took about 3 minutes on a laptop CPU, cut open
hole edges by 74% (70,304 to 18,128) and loose pieces from 2,048 to 76, at the same
triangle count. Edges come out slightly rounder than the original.

### Making scans smaller

The viewer opens meshopt-compressed GLBs (`EXT_meshopt_compression` with
`KHR_mesh_quantization`), so a scan can be shrunk before upload with the standard
glTF-Transform tool. It joins pieces, merges duplicate points, simplifies only where the
shape barely changes, stores coordinates in fewer bits and packs the result:

```
npx @gltf-transform/cli@4.3.0 optimize scan-filled.glb scan-small.glb --compress meshopt
```

The hole-filled hallway went from 36 MB and 1.37M triangles to 3.9 MB and 744k triangles,
with no visible change, and still routes. Smaller files load faster on phones and leave room
under the 400 MB limit. Clean up first (`scan_fill_holes.py`, which also drops floating
fragments), then compress: compressed files can't be read back by `scan_fill_holes.py`.

## Places on a map

New GLB maps upload as **Private**. The upload's finish screen leads to **Next: label places**. On **Manage map**, the owner double-clicks the floor in front of a room or door, names it and picks a type (`PlaceEditor`). Pins can be renamed, re-typed, moved or removed later. Sharing beyond Private stays locked (`VisibilityPicker lockedReason`) until the map has at least one place.

Guests see each place as a floating label on the 3D model (`SpaceViewer places`), plus a **Places · N** list. With automatic routing on, tapping a label sets the start, then the destination. Place positions are in the model's own coordinates, so pins follow the model's saved transform. API contract: [Map places](../../docs/scan-api.md#map-places).

## Run locally

Requires Node 22+ and pnpm. Set `API_TARGET=http://127.0.0.1:8001` for the legacy mock.

```sh
py -3 -B tools/scan_mock.py --port 8001        # from the repo root (or: make dev-api)
cd apps/web && pnpm install && API_TARGET=http://127.0.0.1:8001 pnpm dev
```

The mock with `--demo-cues` still supplies synthetic directions through fixture HTTP calls. Interactive owner screens now require the Next.js Auth0 session.

With the real authenticated backend, open `http://localhost:5173/maps` (Your maps). The legacy upload form at **New map** (`/maps/new`) lets you choose `fixtures/venue/scene.ply`, pick a visibility and upload. The page shows the guest link, a copy button and a QR code, and lets you change visibility or private viewers afterwards. You can also upload with the curl command in the [API README](../../services/api/README.md). Then open `http://localhost:5173/s/<shareId>`. The website uses the backend session in every build and sends no `X-Dev-User` header. The Python mock supports fixture HTTP tests; its stand-in accounts no longer sign the React app in. `pnpm build` type-checks and writes static files to `dist/`. `pnpm preview` serves them with the same proxy on port 4173. The host must serve `index.html` for `/s/<shareId>`.

| Path | What it does |
| --- | --- |
| `src/index.css` | Color and type tokens from [DESIGN.md](DESIGN.md) as a Tailwind v4 `@theme`. |
| `src/lib/shares.ts` | Calls `GET /api/shares/<id>` and its asset. The API answers 404 both for unknown and for denied shares, so the guest sees one state. |
| `src/lib/ply.ts` | Parses ASCII or binary PLY with `PLYLoader`, rejects empty or non-finite scans, keeps at most 600k points. |
| `src/components/ScanViewer.tsx` | Colored points on `night`, DPR capped at 2, orbit (one finger turns, two fingers zoom and pan), framed from behind the entrance (+Z). Loaded lazily alongside the metadata request. |
| `src/components/AppLayout.tsx` | Signed-in shell: forest sidebar (My maps, Community, New map, account) on desktop, top bar and bottom tab bar on phones. |
| `src/routes/MyMaps.tsx` | `/maps`: your maps (`GET /api/scans/mine`) and maps shared with you (`GET /api/scans/shared`), with All, Public, Unlisted, Private and Shared with me filters. Each card's ⋯ menu offers Copy link, Manage map and Delete… (with a confirmation). |
| `src/routes/ManageMap.tsx` | `/maps/:shareId`: rename, link and QR code, change who can open it, review landmark directions, and delete. Only for the map's owner. |
| `src/components/CueReview.tsx` | Landmark directions on Manage map: each of Gemini's drafts with its source photo (owner-only), landmark and confidence, editable text, and Approve, Reject, Unapprove or Undo reject. Needs the map's `revisionId`; uploaded files have none and say so. |
| `src/lib/cues.ts` | Cue client for Sam's proposed endpoints: `GET /api/scan-revisions/<id>/cues` (owner), `PATCH /api/cues/<id>` with `{instruction?, status?}`, and `GET /api/shares/<id>/cues` (guests, approved only; any failure just hides directions). |
| `src/components/ConfirmDialog.tsx` | Modal confirmation on `<dialog>`: focus starts on Cancel, Escape cancels, focus returns afterward. |
| `src/routes/Community.tsx` | `/community`: public maps from `GET /api/scans/public` with their names, and loading placeholders, empty and error states. |
| `src/lib/auth.tsx` | Shared backend session context, account controls and protected map routes; loading, retry and signed-out states. |
| `src/lib/preferences.tsx` | Settings kept on the device (no account needed): text size, motion, and the "Avoid stairs" default. `useTripAvoidStairs` gives each map a per-trip switch that starts from the default and doesn't change it. |
| `src/routes/Settings.tsx` | `/settings`: Text size (Default, Large, Extra large), Motion (Match my device, Reduce, Allow), Avoid stairs by default. |
| `src/routes/Upload.tsx` | `/maps/new` (`/upload` redirects here): an optional name (suggested from the file name), choose a PLY or GLB (checked for type, size and header before sending), pick Public, Unlisted or Private, upload with progress and cancel. Uses `POST /api/scans` for authenticated GLB imports on the Next.js API. Production imports accept GLB up to 400 MiB; the fixture mock also accepts PLY. |
| `src/components/SharePanel.tsx` | After upload: guest link, copy, QR code, preview, and visibility changes through `PATCH /api/scans/<id>` (the scan's `id` from `/mine` on the Next.js API, the share ID on the mock). People already added to a private map are listed read-only; adding and removing people waits for a people picker. If the Next.js API refuses Public because the map's space is private, it says "To make this map public, its parent space must also be public." Warns when the link is `localhost`, which a phone can't open. |
| `src/lib/scans.ts` | Owner API client (upload, sharing) with readable messages for 400, 401, 413, 415 and network failures. |
| `src/routes/GuestView.tsx` | `/s/:shareId`: PLY point clouds (`ScanViewer`) or GLB models (`SpaceViewer`, with the share's saved transform), with loading, not-found/denied, download and parse-failure states. When the owner approved landmark directions, a **Directions** button opens them above the map controls, each marked "Approved by the map owner". |
| `src/routes/SpaceView.tsx` | Accessible Next.js scans and graph, route selection, owner upload/alignment and graph tools. |
| `src/components/SpaceViewer.tsx` | GLTFLoader meshes/materials, combined transformed bounds, graph/route overlays and orbit controls. |
| `src/lib/scan-surfaces.ts` | Makes phone scans easier to read without changing their geometry: hides ceilings (ARKit-labelled ceiling faces, or on unlabelled phone scans the downward-facing surfaces in the upper half; a **Show ceiling** button brings them back and clicks pass through hidden ones), turns on the GPU's best anisotropic filtering for photo textures, and converts Path Capture vertex colours from camera sRGB to linear so they no longer look washed out. Test room: `fixtures/venue/classified-room.glb` from `tools/make_classified_room.py`. |
| `src/routes/Home.tsx`, `src/landing/` | The landing page at `/`, described below. |

## Landing page

`/` is the public landing page. Sections, top to bottom, with what moves in each:

| Section | File | Motion |
| --- | --- | --- |
| Hero | `Hero.tsx`, `HeroScene.tsx` | A 3D scan of the fixture's T corridor assembles from scattered dots, a coral route draws with footprints, and dots near the mouse glow. Replays after 20 s idle. Route to and QR panels float over it. |
| Why Not 404 | `Problem.tsx` | A looping player: map apps, indoor maps, floor plans, the "accessible" checkmark, then Not 404. Pauses on hover, keyboard focus, off screen, or with Pause. |
| How it works | `AppTour.tsx` | Laptop: a sticky CSS phone swaps screens for the step in the middle. Phone: one row per step, alternating sides. |
| Who it's for | `WhoUses.tsx` | Sign-style people walk to their signs one after another along one route. |
| Team | `Creators.tsx` | Cards start as a pile and fan out; they turn over to links on hover, tap or keyboard focus. Photos are in `src/assets/team/`, résumés in `public/resumes/`. |
| Join us | `Join.tsx`, `Footprint.tsx` | Footprints walk across on a loop; with a mouse, footprints follow the cursor. |

Nothing pins or takes over scrolling. With Reduce motion, every section shows its finished state and nothing moves on its own. The hero scan is generated from the fixture's layout (`venue.ts`) because the fixture has only 93 points.

The QR codes open `VITE_DEMO_SHARE_URL` (a hosted guest link, `…/s/<shareId>`). Without it they open Community on the current site, which a phone can't reach when that's `localhost`.

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
