import { fileURLToPath, URL } from "node:url"
import solid from "vite-plugin-solid"
import { defineConfig } from "vitest/config"

export default defineConfig(({ mode }) => ({
  base: "./",
  plugins: [solid({ hot: mode !== "test" })],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    restoreMocks: true,
    clearMocks: true,
  },
}))
