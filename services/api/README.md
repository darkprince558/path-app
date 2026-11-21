# Upload and sharing API

Sam owns the durable backend. The team can integrate against the local reference API now with Python 3.9+ and Make. From the repo root, run `make dev-api` in one terminal, then upload the fixture from another.

```sh
curl --fail-with-body -sS \
  -H 'X-Dev-User: organizer' \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @fixtures/venue/scene.ply \
  'http://127.0.0.1:8001/api/scans?format=ply&visibility=unlisted'
```

The response includes `shareId` and `sharePath`. Open `http://127.0.0.1:8001` followed by that path in another browser on the same computer. The development page links to the exact uploaded bytes. Arielle’s guest page will use the metadata and asset endpoints below to render the model.

| Request | Behavior |
| --- | --- |
| `POST /api/scans?format=ply&visibility=unlisted` | Send raw bytes. Accepts `ply` or `glb`; visibility defaults to `private`. Returns 201 with `{shareId, sharePath}`. |
| `GET /api/scans/public` | Returns `{scans: [{shareId, sharePath}]}` for public discovery. |
| `GET /api/shares/<shareId>` | Returns `{shareId, format, assetPath}` to a permitted viewer. |
| `GET /api/shares/<shareId>/asset` | Returns the uploaded file after the same access check. |
| `PATCH /api/scans/<shareId>` | Owner sends JSON with `visibility` and the complete replacement list `viewerIds`. Returns the new sharing state. |

To grant private access, send `{"visibility":"private","viewerIds":["teammate"]}` as the organizer. Repeat with an empty list to revoke access. The smoke test covers both changes, the raw asset URL, and unauthenticated discovery.

The mock binds to loopback, uses `X-Dev-User` to simulate an account, checks file headers, limits uploads to 32 MiB, and discards data on exit. On the hosted API derive identity from a verified session, validate the uploaded model, persist grants, and enforce visibility on every read. Use the deployed site’s origin for portable share URLs. [Architecture and data model](../../docs/architecture.md)
