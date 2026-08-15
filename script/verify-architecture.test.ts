import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { verifyArchitecture } from "./verify-architecture"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "jyycode-architecture-"))
  temporaryDirectories.push(root)
  await Promise.all(
    Object.entries(files).map(async ([name, contents]) => {
      const path = join(root, name)
      await Bun.write(path, contents)
    }),
  )
  return root
}

describe("verifyArchitecture", () => {
  test("rejects imports that cross privileged package boundaries", async () => {
    const root = await fixture({
      "packages/core/src/runtime.ts": 'import "@jyycode-ai/jyycode/src/session/session"\n',
      "packages/llm/src/adapter.ts": 'import "@jyycode-ai/jyycode/src/session/prompt"\n',
      "packages/jyycode/src/session/session.ts": "export {}\n",
    })

    const violations = await verifyArchitecture({ rootDir: root })

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: "core-cannot-import-product" }),
        expect.objectContaining({ rule: "llm-cannot-import-session" }),
      ]),
    )
  })

  test("rejects native process imports outside explicit platform adapters", async () => {
    const root = await fixture({
      "packages/jyycode/src/session/runtime.ts": 'import { spawn } from "node:child_process"\n',
      "packages/core/src/cross-spawn-spawner.ts": 'import { spawn } from "node:child_process"\n',
    })

    const violations = await verifyArchitecture({ rootDir: root })

    expect(violations).toEqual([
      expect.objectContaining({
        rule: "business-cannot-import-child-process",
        source: "packages/jyycode/src/session/runtime.ts",
      }),
    ])
  })

  test("rejects core dependencies on the plugin implementation package", async () => {
    const root = await fixture({
      "packages/core/src/runtime.ts": 'import { Plugin } from "@jyycode-ai/plugin"\n',
      "packages/plugin/src/index.ts": "export const Plugin = {}\n",
    })

    const violations = await verifyArchitecture({ rootDir: root })

    expect(violations).toEqual([expect.objectContaining({ rule: "core-cannot-depend-on-plugin" })])
  })

  test("permits the documented native process adapters", async () => {
    const root = await fixture({
      "packages/core/src/cross-spawn-spawner.ts": 'import { spawn } from "node:child_process"\n',
      "packages/core/src/process-supervisor.ts": 'import { execFile } from "node:child_process"\n',
      "packages/jyycode/src/pty/pty.bun.ts": 'import { spawn } from "node:child_process"\n',
    })

    await expect(verifyArchitecture({ rootDir: root })).resolves.toEqual([])
  })

  test("rejects completed migration markers in product source", async () => {
    const root = await fixture({
      "packages/jyycode/src/session/legacy.ts": `// ${["TODO", "(v2)"].join("")}: remove this bridge\n`,
    })

    const violations = await verifyArchitecture({ rootDir: root })

    expect(violations).toEqual([expect.objectContaining({ rule: "legacy-v2-marker" })])
  })

  test("rejects removed TUI and auth compatibility surfaces", async () => {
    const root = await fixture({
      "packages/jyycode/src/plugin/tui.ts": `const shim = ${["createCommand", "Shim"].join("")}\n`,
      "packages/plugin/src/auth.ts": `type Typo = ${["AuthOuath", "Result"].join("")}\ntype Prompt = { ${["condition?:", " (inputs:"].join("")} unknown) => boolean }\n`,
      "packages/jyycode/src/session/payload.ts": `type Options = { ${["preview", "Chars?:"].join("")} number }\nconst oldFile = ${["CONTEXT", ".md"].join("")}\n`,
      "packages/jyycode/src/session/archive.ts": `const ArchivedTimestamp =${[" Schema.Finite"].join("")}\n`,
      "packages/app/src/inspector.ts": `const ${["legacy", "Panes"].join("")} = {}\nconst key = ${["thinking_", "visibility"].join("")}\n`,
      "packages/sdk/src/provider.ts": `${["export type Provider =", " PublicProvider"].join("")}\n`,
    })

    const violations = await verifyArchitecture({ rootDir: root })

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: "legacy-tui-command-shim" }),
        expect.objectContaining({ rule: "legacy-auth-type-alias" }),
        expect.objectContaining({ rule: "legacy-auth-prompt-condition" }),
        expect.objectContaining({ rule: "legacy-character-preview-limit" }),
        expect.objectContaining({ rule: "legacy-thinking-visibility" }),
        expect.objectContaining({ rule: "legacy-inspector-pane-migration" }),
        expect.objectContaining({ rule: "legacy-negative-archive-time" }),
        expect.objectContaining({ rule: "legacy-provider-type-alias" }),
        expect.objectContaining({ rule: "legacy-context-instruction-file" }),
      ]),
    )
  })
})
