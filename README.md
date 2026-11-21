# Path App

[Record a hallway on your phone, process it on your Mac and share the textured scan over Wi-Fi](docs/phone-recorder.md).

Path App is a collaborative 3D mapping and navigation project for Hack Western 13. Walk a route with a LiDAR-capable phone, turn the capture into an interactive 3D view, and send someone a link or QR code they can use to find their way.

Visitors can see what a hallway, entrance, or turn looks like before they reach it. Event organizers can map rooms and booths, schools and companies can share routes across their campuses, and hikers can share trails they’ve walked. Capture can be handheld or hands-free with a custom 3D-printed wearable phone mount.

## Start here

1. **[Set up your laptop](prompts/team-chat.md)** with the copy-paste commands for your OS.
2. **[Open the live team board](https://github.com/darkprince558/path-app/issues/8)** to see who owns each task and their latest checkpoint. [Create or claim a task](docs/tasks.md) from GitHub or the terminal.
3. **[Start your agent task](prompts/start-task.md)** in its own worktree. Record reusable decisions and findings in the [team notebook](knowledge/README.md).

The [editable roadmap](planning/ROADMAP.md) shows the next milestones. The [planning index](planning/README.md) links the architecture, deployment and demo plans.

Our first milestone is to upload one real scan, share an unlisted link, and open the interactive 3D view on a second phone. Scans can be **Public** (listed for everyone), **Unlisted** (anyone with the link), or **Private** (owner and invited accounts).

To try your own hallway video locally, follow the [phone video to 3D instructions for Mac](apps/capture/README.md#try-a-regular-phone-video-on-a-mac). One command exports a colored PLY and opens it in the Path viewer.

| Building | Start with |
| --- | --- |
| Website and 3D viewer | [Arielle’s web workspace](apps/web/README.md) |
| Uploads, sharing and access | [Sam’s API workspace and local commands](services/api/README.md) · [Live deployment plan](docs/deployment.md) |
| Phone capture and export | [Krishna and Anish’s capture workspace](apps/capture/README.md) |
| Shared decisions and development rules | [Architecture](docs/architecture.md) · [Human and coding-agent workflow](AGENTS.md) |
| Working in Claude Code and Codex | [Set up Entire](docs/entire.md) · [Claim a task and launch parallel agents](docs/agent-tasks.md) · [Handoff and review skills](docs/agent-skills.md) |

Run `make check` from the repo root with Python 3.9+ and Make. This checks a synthetic venue and exercises the local upload/share API, including grants and revocation. Start the mock with `make dev-api`. It stores scans for the current process and serves a download page for integration. The guest 3D website, durable backend and device capture are the team's implementation work.

## Hackathon MVP

1. **Capture** a small venue section with a phone’s camera and LiDAR.
2. **Map** the scan into a viewable 3D scene using camera-colored point clouds. Organizers connect walkable waypoints, label destinations, and align contributed sections using manually verified anchors.
3. **Publish** the event and scene assets in the cloud. Organizers approve contributed scans, then share the event via a link or QR code.
4. **Navigate** from a QR-marked starting point to a selected destination. The browser computes a route on the waypoint graph with A* or Dijkstra and draws it over the 3D scene.

Gemini will analyze scan images and return structured suggestions for room numbers, signs, entrances, stairs, and landmarks, along with draft directions. Organizers review suggestions before publishing.

The demo target is one real venue section, two destinations, one route opened from a QR code, and one approved contributed scan appearing in the guest view.

## Team

- **Sam** — Backend APIs, data model, cloud storage, uploads, and event sharing.
- **Krishna and Anish** — Phone capture, scan processing, alignment, and upload integration.
- **Arielle** — Frontend, 3D viewer, route editing, pathfinding, and event experience.

## Prize strategy

Build one demo for **Best Use of Gemini API** and **Most Adventurous**. A first-time visitor chooses an unfamiliar destination, opens a scan and follows a landmark cue grounded in the actual capture. See the [ranked prize plan and 90-second demo](docs/prize-plan.md) and the [Gemini landmark design](docs/gemini-demo.md).
