import { defineConfig } from "vite";

export default defineConfig({
  server: {
    proxy: {
      "/v1": { target: "http://127.0.0.1:8084", ws: true },
    },
  },
  worker: { format: "es" },
  build: { target: "es2022" },
});
