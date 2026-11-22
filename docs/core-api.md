# Core API contract

Sam owns these Next.js route handlers in `services/api`. They use the Auth0 server session on same-origin browser requests or a bearer access token for the `AUTH0_AUDIENCE` API. Mutations require sign-in. Public reads work signed out; unauthorized private IDs return 404. JSON errors use `{ "error": { "code", "message" } }`; validation errors also include `issues`. IDs are UUIDs. Coordinates use the space's shared Y-up frame: metres when calibrated, otherwise explicitly relative units. Declare this in `space.boundary.coordinateSystem` and use the same units for nodes, edge distances and scan transforms; see the [scan data contract](scan-data-contract.md). Navigation edges are explicit; geometry does not create routes.

| Resource | Routes | Response shape |
| --- | --- | --- |
| Spaces | `GET/POST /api/spaces`, `GET/PATCH/DELETE /api/spaces/:id` | `{spaces: [...]}` or `{space}` |
| Graph | `GET /api/spaces/:id/graph`, `POST /api/spaces/:id/graph/nodes`, `POST /api/spaces/:id/graph/edges` | `{spaceId,nodes,edges,destinations}`, `{node}`, `{edge}` |
| Destinations | `GET/POST /api/destinations`, `GET/PATCH/DELETE /api/destinations/:id` | `{destinations: [...]}` or `{destination}`; list accepts `?spaceId=<uuid>` |
| Saved paths | `GET/POST /api/paths`, `GET/PATCH/DELETE /api/paths/:id` | `{paths: [...]}` or `{path}` with ordered `waypoints` and coordinates |
| Events | `GET/POST /api/events`, `GET /api/events/mine`, `GET/PATCH/DELETE /api/events/:id` | `{events: [...]}`; `mine` is the caller's organized and joined events with `role`, `mapCount`, `memberCount`; single events return `{event,spaces,paths,destinations,role,maps}` |
| Event maps | `POST /api/events/:id/maps` `{scanId}`, `DELETE /api/events/:id/maps/:scanId` | Organizer only, own maps only; both return the event like `GET` |
| Membership | `GET/POST/DELETE /api/events/:id/join`, `GET /api/events/:id/members`, `DELETE /api/events/:id/members/:userId` | `GET ?code=` previews an invite (`{event,organizer,mapCount,role}`, works signed out, 404 for a wrong code); join returns `{eventId,role}`; member list (with `displayName`) is organizer-only |

Successful creates return 201, deletes 204. Common errors are 400 for invalid input, 401 for missing/invalid authentication on writes, 403 for authenticated nonowners attempting to modify a visible resource, 404 for missing or inaccessible resources, and 409 for references that prevent deletion or visibility changes. The space owner creates graph nodes, edges and destinations. Both edge nodes and each destination node must be in that space; the database also enforces this. A saved path has at least two nodes, and each consecutive pair must follow a directed edge or either direction of a bidirectional edge. Public paths require public spaces.

An event links existing spaces, paths and destinations by ID. Every linked path and destination must belong to a linked space. Public events can link only public spaces and public paths. A private event may link the organizer's private resources; members who join with its invite code can then read those linked spaces, graphs and paths. The invite code appears only to the event owner. Event responses contain no storage URLs. A public event or path cannot grant access to private scans.

**Event maps** (`event_maps`, migration `0008`) are how events share models. The organizer attaches their own maps, of any visibility. Members of that event can open exactly those maps (`canReadScan`), with everything a map offers: model, places, directions and approved cues. Linking a space through `event_spaces` still grants no scan access, so other maps in the same space stay private. `maps` in an event response lists the attached maps the caller can open, as `{shareId, sharePath, name, format, visibility, updatedAt}`, plus the scan `id` for the organizer. Detaching a map, leaving or being removed takes effect on the next request. Deleting a map removes it from every event.

## Try it locally

Run `npm run db:migrate` and `npm run dev` in `services/api` after configuring `.env.local` and `DATABASE_URL`. Sign in at `http://localhost:3000`. Paste the following into that page's browser console; same-origin `fetch` sends the Auth0 session cookie automatically. Use a fresh database or choose new names. Each line builds on the IDs returned by the previous one.

```js
const send = async (url, method, data) => {
  const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const value = await response.json();
  if (!response.ok) throw value;
  return value;
};
const { space } = await send('/api/spaces', 'POST', { name: 'Demo hall', visibility: 'public' });
const { node: entrance } = await send(`/api/spaces/${space.id}/graph/nodes`, 'POST', { x: 0, y: 0, z: 0 });
const { node: desk } = await send(`/api/spaces/${space.id}/graph/nodes`, 'POST', { x: 3, y: 0, z: 0 });
await send(`/api/spaces/${space.id}/graph/edges`, 'POST', { fromNodeId: entrance.id, toNodeId: desk.id, distance: 3, bidirectional: false });
const { destination } = await send('/api/destinations', 'POST', { spaceId: space.id, nodeId: desk.id, name: 'Registration' });
const { path } = await send('/api/paths', 'POST', { spaceId: space.id, name: 'Entrance to registration', visibility: 'public', nodeIds: [entrance.id, desk.id] });
const { event } = await send('/api/events', 'POST', { name: 'Demo event', visibility: 'public', spaceIds: [space.id], pathIds: [path.id], destinationIds: [destination.id] });
console.log(await fetch(`/api/spaces/${space.id}/graph`).then(r => r.json()));
console.log(await fetch(`/api/events/${event.id}`).then(r => r.json()));
```

Open the graph, path and event URLs in a signed-out private window to verify public reads. A signed-out `POST /api/spaces` returns 401. Try creating a path with `[desk.id, entrance.id]` to see a 400 for reverse travel on the one-way edge. For private sharing, create a private space and private event that links it; the owner receives `event.inviteCode`. A second signed-in user can `POST /api/events/:id/join` with `{ "inviteCode": "..." }`, then read the linked private graph. Leaving or organizer revocation removes that access on the next request.

For automated checks, run `npm run typecheck`, `npm test`, and `npm run build`. The database integration test runs when `TEST_DATABASE_URL` points to a **disposable migrated PostgreSQL database**; otherwise it is skipped. Do not point it at Tiger Data production. Apply migrations with `DATABASE_URL=<test-url> npm run db:migrate`, then run `TEST_DATABASE_URL=<test-url> npm test`.
