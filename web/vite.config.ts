import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const resolveApiTarget = () => {
  const envTarget = process.env.VITE_API_URL?.trim();
  if (envTarget) return envTarget.replace(/\/$/, "");
  const port = Number(process.env.SHOGUN_PORT ?? "4090");
  const resolvedPort = Number.isFinite(port) && port > 0 ? port : 4090;
  return `http://localhost:${resolvedPort}`;
};

const resolveWebPort = () => {
  const port = Number(process.env.SHOGUN_WEB_PORT ?? "4091");
  return Number.isFinite(port) && port > 0 ? port : 4091;
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: resolveWebPort(),
    strictPort: true,
    proxy: {
      "/api": {
        target: resolveApiTarget(),
        changeOrigin: true
      },
      "/ws": {
        target: resolveApiTarget(),
        ws: true
      }
    }
  },
  build: {
    outDir: "dist"
  }
});
