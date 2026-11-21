# Website

Arielle owns the organizer upload flow and guest 3D viewer. Build the website here. Start with an upload control, the three visibility choices, a copy-link action and a guest route at `/s/<shareId>`. Display upload, loading and processing failures where they occur.

For the first integration, upload the sample PLY as **Unlisted**, open the returned link in a signed-out session, and use the response’s `assetPath` to load the point cloud with vertex colors. A guest should be able to orbit the scene and recognize the corridor junction. Use the actual phone export to choose camera framing, point size and mobile performance targets.

The local API provides fixture bytes and exercises sharing rules. Replace its test page with the website’s guest route during integration. [Local API commands](../../services/api/README.md) · [Capture format and viewer notes](../../docs/scan-formats.md)

## Run locally

Requires Node 22+ and pnpm. The dev server proxies `/api` to the scan mock on `127.0.0.1:8001`.

```sh
py -3 -B tools/scan_mock.py --port 8001        # from the repo root (or: make dev-api)
cd apps/web && pnpm install && pnpm dev        # http://localhost:5173
```

Upload `fixtures/venue/scene.ply` as Unlisted with the curl command in the [API README](../../services/api/README.md), then open `http://localhost:5173/s/<shareId>`. The browser sends no `X-Dev-User` header, so it is a signed-out guest. `pnpm build` type-checks and writes static files to `dist/`. `pnpm preview` serves them with the same proxy on port 4173. The host must serve `index.html` for `/s/<shareId>`.

| Path | What it does |
| --- | --- |
| `src/index.css` | Color and type tokens from [DESIGN.md](DESIGN.md) as a Tailwind v4 `@theme`. |
| `src/lib/shares.ts` | Calls `GET /api/shares/<id>` and its asset. The API answers 404 both for unknown and for denied shares, so the guest sees one state. |
| `src/lib/ply.ts` | Parses ASCII or binary PLY with `PLYLoader`, rejects empty or non-finite scans, keeps at most 600k points. |
| `src/components/ScanViewer.tsx` | Colored points on `night`, DPR capped at 2, orbit (one finger turns, two fingers zoom and pan), framed from behind the entrance (+Z). Loaded lazily alongside the metadata request. |
| `src/routes/GuestView.tsx` | `/s/:shareId` with loading, not-found/denied, download, parse-failure and unsupported-format (GLB) states. |
