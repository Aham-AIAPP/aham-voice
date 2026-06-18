import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Orchisky Voice frontend.
//
// Build target: ../frontend/dist (the static-served bundle that the existing
// frontend_static_server.py picks up). The backend reads dist files directly,
// so a clean `npm run build` is all you need to ship a new frontend.
//
// Dev server: 5174 (the production static server holds 5173). API calls are
// proxied to the FastAPI backend on 8000 so the same axios client works in
// dev and prod.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5174,
    strictPort: false,
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: path.resolve(__dirname, "../frontend/dist"),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 800,
  },
});
