import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The plugin resolves configPath and outDir against `root`.
export default defineConfig({
  root: "playground",
  plugins: [react(), cloudflare({ configPath: "../wrangler.jsonc" })],
  build: { outDir: "../dist", emptyOutDir: true },
});
