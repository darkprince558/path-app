import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The local scan mock (tools/scan_mock.py) listens on IPv4 loopback only,
// so target 127.0.0.1 rather than "localhost" (which Node may resolve to ::1).
const API_TARGET = "http://127.0.0.1:8001";

const proxy = {
  "/api": { target: API_TARGET, changeOrigin: false },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
});
