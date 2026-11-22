import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? "dev"),
  },
  build: {
    // Flags stay files of their own, fetched only when shown, rather than ~200 inlined in the bundle.
    assetsInlineLimit: (file) => (file.includes("flag-icons") ? false : undefined),
  },
  server: {
    port: 1490,
    strictPort: true,
    // The API server (npm run server) during development.
    proxy: {
      "/api": "http://localhost:8840",
      "/v1": "http://localhost:8840",
    },
    watch: {
      ignored: ["**/server/**"],
    },
  },
});
