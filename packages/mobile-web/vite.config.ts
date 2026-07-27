import { fileURLToPath, URL } from "node:url"
import solid from "vite-plugin-solid"
import { defineConfig } from "vitest/config"

export default defineConfig(({ mode }) => ({
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
    host: "0.0.0.0",
    port: 4174,
    strictPort: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    restoreMocks: true,
    clearMocks: true,
  },
}))
