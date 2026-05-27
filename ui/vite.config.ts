import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "ui",
  base: "/app/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/calls": "http://127.0.0.1:3000",
      "/answerCall": "http://127.0.0.1:3000",
      "/webhook-pings": "http://127.0.0.1:3000",
      "/media": {
        target: "ws://127.0.0.1:3000",
        ws: true,
      },
    },
  },
});
