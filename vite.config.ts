import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// The dev server answers only this machine unless told otherwise: the backend
// behind it can run uploaded Python, so it should not be on the trackside
// WiFi by accident. HOST=0.0.0.0 (set in the Docker image) widens the bind;
// QUICKSCOPE_ALLOWED_HOSTS lists extra hostnames the server will answer to.
const extraHosts = (process.env.QUICKSCOPE_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  base: "./",
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    host: process.env.HOST ?? "127.0.0.1",
    port: 5173,
    allowedHosts: extraHosts,
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
  test: {
    root: path.resolve(import.meta.dirname, "client"),
    environment: "node",
    setupFiles: [path.resolve(import.meta.dirname, "client", "src", "test", "dom-setup.ts")],
  },
});
