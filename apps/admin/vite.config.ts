import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // What `wrangler deploy` uploads as static assets.
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 4330,
    proxy: {
      // `pnpm dev` runs Vite for the client and `wrangler dev` for the Worker.
      "/api": "http://127.0.0.1:8790",
    },
  },
});
