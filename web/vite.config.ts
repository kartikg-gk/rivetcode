import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const daemon = `127.0.0.1:${process.env.RIVET_PORT ?? 4319}`;

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
  build: { outDir: fileURLToPath(new URL("../dist/web", import.meta.url)), emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: { proxy: { "/api": { target: `http://${daemon}`, ws: true } } },
});
