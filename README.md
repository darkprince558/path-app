# Path App

Path App is a collaborative 3D mapping and navigation project for Hack Western 13. Walk a route with a LiDAR-capable phone, turn the capture into an interactive 3D view, and send someone a link or QR code they can use to find their way.

Visitors can see what a hallway, entrance, or turn looks like before they reach it. Event organizers can map rooms and booths, schools and companies can share routes across their campuses, and hikers can share trails they’ve walked. Capture can be handheld or hands-free with a custom 3D-printed wearable phone mount.

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

## Prize tracks

- MLH Best Use of Gemini API
- Organizers’ Choice – Most Adventurous
