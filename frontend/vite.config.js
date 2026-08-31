import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // REST API calls
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
      // WebSocket connections
      "/ws": {
        target: "ws://localhost:8080",
        ws: true,
      },
    },
  },
});
