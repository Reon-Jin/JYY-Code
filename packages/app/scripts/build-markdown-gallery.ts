import { build } from "vite"
import solid from "vite-plugin-solid"
import { readFile, unlink, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

const directory = resolve("../../dist/previews/markdown-gallery")
await build({
  configFile: false,
  base: "./",
  plugins: [solid()],
  publicDir: false,
  build: {
    outDir: directory,
    emptyOutDir: true,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    reportCompressedSize: false,
    rollupOptions: {
      input: resolve("markdown-gallery.html"),
      output: { inlineDynamicImports: true, entryFileNames: "gallery.js", assetFileNames: "gallery.[ext]" },
    },
  },
})
let html = await readFile(resolve(directory, "markdown-gallery.html"), "utf8")
const js = await readFile(resolve(directory, "gallery.js"), "utf8")
const css = await readFile(resolve(directory, "gallery.css"), "utf8")
html = html
  .replace(
    /<script[^>]+src="[^"]+"[^>]*><\/script>/,
    () => `<script type="module">${js.replace(/<\/script/gi, "<\\/script")}</script>`,
  )
  .replace(/<link[^>]+href="[^\"]+\.css"[^>]*>/, () => `<style>${css}</style>`)
await writeFile(resolve(directory, "markdown-gallery.html"), html)
await Promise.all([unlink(resolve(directory, "gallery.js")), unlink(resolve(directory, "gallery.css"))])
console.log(`Standalone gallery: ${resolve(directory, "markdown-gallery.html")}`)
