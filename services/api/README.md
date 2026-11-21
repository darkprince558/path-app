# Upload and sharing API

Sam owns the durable backend. The team can integrate against the local reference API now with Python 3.9+ and Make. From the repo root, run `make dev-api` in one terminal, then upload the fixture from another.

```sh
curl --fail-with-body -sS \
  -H 'X-Dev-User: demo-owner' \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @fixtures/venue/scene.ply \
  'http://127.0.0.1:8001/api/scans?format=ply&visibility=unlisted&name=Engineering%20building'
```

The response includes `shareId` and `sharePath`. Open `http://127.0.0.1:8001` followed by that path in another browser on the same computer. The development page links to the exact uploaded bytes. Arielle’s guest page will use the metadata and asset endpoints below to render the model.

| Request | Behavior |
| --- | --- |
| `POST /api/scans?format=ply&visibility=unlisted&name=…` | Send raw bytes. Accepts `ply` or `glb`. Visibility defaults to `private`. `name` is optional (default `Untitled map`). Returns 201 with `{shareId, sharePath, name}`. |
| `GET /api/scans/public` | Returns `{scans: [{shareId, sharePath, name, updatedAt}]}` for public discovery, newest first. No sign-in needed. |
| `GET /api/scans/mine` | The signed-in account's own maps, newest first: `{scans: [{shareId, sharePath, name, format, visibility, viewerIds, updatedAt}]}`. 401 when signed out. |
| `GET /api/scans/shared` | Maps other accounts added the signed-in account to: `{scans: [{shareId, sharePath, name, format, visibility, owner, updatedAt}]}`, without anyone's viewer list. 401 when signed out. |
| `GET /api/shares/<shareId>` | Returns `{shareId, format, assetPath, name}` to a permitted viewer. |
| `GET /api/shares/<shareId>/asset` | Returns the uploaded file after the same access check. |
| `PATCH /api/scans/<shareId>` | Owner sends JSON with any of `name`, `visibility` and `viewerIds`. Fields left out keep their value. `viewerIds`, when sent, is the complete replacement list. Returns `{shareId, name, visibility, viewerIds}`. |
| `DELETE /api/scans/<shareId>` | Owner only. Returns 204, removes the stored file, and every route for that share then answers 404. Anyone else gets 404. |

Names are 1–80 characters after trimming and collapsing spaces, with no control characters. Invalid names get 400. `updatedAt` is an ISO 8601 UTC time that changes on upload and on every `PATCH`.

To grant private access, send `{"visibility":"private","viewerIds":["teammate"]}` as the owner. Repeat with an empty list to revoke access. To rename, send `{"name":"Library study rooms"}`. The smoke test covers these changes, partial changes, the owner and shared lists, deletion, the raw asset URL, and unauthenticated discovery.

The mock binds to loopback, uses `X-Dev-User` to simulate an account, checks file headers, limits uploads to 32 MiB, and discards data on exit. On the hosted API derive identity from a verified session, validate the uploaded model, persist grants, and enforce visibility on every read. Use the deployed site’s origin for portable share URLs. [Architecture and data model](../../docs/architecture.md)
