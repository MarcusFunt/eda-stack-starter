import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const localApiTarget = process.env.EDA_STUDIO_DEV_API_TARGET ?? "http://127.0.0.1:8765";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: localApiTarget,
        changeOrigin: false,
      },
    },
  },
});
