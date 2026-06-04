import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import { resolve } from "path"

export default defineConfig({
  plugins: [solid()],

  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },

  base: "./",

  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
  },

  server: {
    port: 5173,
    strictPort: true,
  },
})
