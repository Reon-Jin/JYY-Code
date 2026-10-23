import { expect, test } from "bun:test"
import { isExcludedChange } from "../../src/snapshot/excludes"

test("excludes temporary environments, dependencies and caches by complete path segment", () => {
  for (const file of [
    ".temp/paintvenv/Lib/site-packages/PIL/Image.py",
    ".tmp/probe.txt",
    "tools/.venv/bin/python",
    "venv/pyvenv.cfg",
    "node_modules/pkg/index.js",
    "bower_components/pkg/index.js",
    "lib/site-packages/pkg.py",
    ".pnpm-store/pkg/index.js",
    ".npm/cache/index",
    "__pycache__/drawing.pyc",
    ".cache/result.png",
    ".pytest_cache/state",
    ".mypy_cache/state",
    ".ruff_cache/state",
    ".jyycode/context/state.json",
    "src/compiled.pyc",
    "src/compiled.pyo",
  ]) {
    expect(isExcludedChange(file)).toBe(true)
    expect(isExcludedChange(file.replaceAll("/", "\\"))).toBe(true)
  }
  for (const file of [
    undefined,
    "drawing.py",
    "drawing.png",
    ".env.example",
    ".github/workflows/test.yml",
    "dist/app.js",
    "build/report.pdf",
    "src/node_modules-guide.ts",
    ".temporary/result.png",
  ]) {
    expect(isExcludedChange(file)).toBe(false)
  }
})
