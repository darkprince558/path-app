# Website

Arielle owns the organizer upload flow and guest 3D viewer. Build the website here. Start with an upload control, the three visibility choices, a copy-link action and a guest route at `/s/<shareId>`. Display upload, loading and processing failures where they occur.

For the first integration, upload the sample PLY as **Unlisted**, open the returned link in a signed-out session, and use the response’s `assetPath` to load the point cloud with vertex colors. A guest should be able to orbit the scene and recognize the corridor junction. Use the actual phone export to choose camera framing, point size and mobile performance targets.

The local API provides fixture bytes and exercises sharing rules. Replace its test page with the website’s guest route during integration. [Local API commands](../../services/api/README.md) · [Capture format and viewer notes](../../docs/scan-formats.md)
