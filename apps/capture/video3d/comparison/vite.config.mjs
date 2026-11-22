import { fileURLToPath } from "node:url";

// Only the guest component gets the extended Canvas. Its original points,
// framing, material and OrbitControls are used verbatim from the web workspace.
export default {
  plugins: [{
    name: "path-capture-camera",
    enforce: "pre",
    resolveId(id, importer) {
      if (id === "@react-three/fiber" && importer?.endsWith("/src/components/ScanViewer.tsx")) {
        return fileURLToPath(new URL("./CameraCanvas.tsx", import.meta.url));
      }
    },
  }],
};
