import { describe, expect, test } from "bun:test"
import path from "node:path"

const packageDir = path.resolve(import.meta.dir, "../..")

async function builtCliPath() {
  const explicit = process.env.JYYCODE_BUILT_CLI
  if (explicit) return path.resolve(explicit)
  const matches = await Array.fromAsync(new Bun.Glob("dist/**/bin/jyycode*").scan({ cwd: packageDir }))
  const current = matches.find((item) => !item.endsWith(".map"))
  if (!current) throw new Error("built CLI artifact missing; run packages/jyycode build --single --skip-install")
  return path.join(packageDir, current)
}

describe("built CLI entrypoint", () => {
  test("runs --version from the built artifact", async () => {
    const binary = await builtCliPath()
    const process = Bun.spawn([binary, "--version"], { stdout: "pipe", stderr: "pipe" })
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ])
    const output = `${stdout}\n${stderr}`.trim()
    expect({ exitCode, output }).toMatchObject({ exitCode: 0 })
    expect(output).toMatch(/\d+\.\d+\.\d+/)
  })
})
