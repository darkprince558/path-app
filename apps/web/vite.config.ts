import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// Keep API and Auth0 requests on the frontend origin. API_TARGET can select the
// legacy scan mock explicitly; GLB space navigation requires the Next.js API.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const target = env.API_TARGET || "http://127.0.0.1:3000";
  const proxy = { "/api": { target, changeOrigin: false }, "/auth": { target, changeOrigin: false } };
  return { plugins: [react(), tailwindcss()], optimizeDeps: { exclude: ["recast-navigation"] }, server: { port: 5173, proxy }, preview: { port: 4173, proxy } };
});
