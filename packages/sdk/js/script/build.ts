#!/usr/bin/env bun
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"

import { createClient } from "@hey-api/openapi-ts"

const jyycode = path.resolve(dir, "../../jyycode")

const generatedOutput = process.env.JYYCODE_SDK_GENERATED_DIR ?? path.join(dir, "src/v2/gen")
const openapiOutput = process.env.JYYCODE_SDK_OPENAPI_PATH ?? path.join(dir, "openapi.json")
const verifyOnly = process.env.JYYCODE_SDK_VERIFY_ONLY === "1"

await $`bun dev generate > ${openapiOutput}`.cwd(jyycode)

await createClient({
  input: openapiOutput,
  output: {
    path: generatedOutput,
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "JyycodeClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

// Patch a @hey-api/openapi-ts codegen bug: SseFn incorrectly passes the
// endpoint's TError into the second generic of ServerSentEventsResult, which
// is the AsyncGenerator's TReturn slot. Iterator return values have nothing
// to do with HTTP errors, and any consumer that calls `.return()` or returns
// from a mock generator gets type-checked against the wrong shape. Drop the
// arg so TReturn defaults to void.
const sseTypesPath = path.join(generatedOutput, "client/types.gen.ts")
const sseTypesFile = Bun.file(sseTypesPath)
const sseTypesSource = await sseTypesFile.text()
const sseResultPatched = sseTypesSource.replace(
  "=> Promise<ServerSentEventsResult<TData, TError>>",
  "=> Promise<ServerSentEventsResult<TData>>",
)
const sseTypesPatched = sseResultPatched.replace(
  "type SseFn = <\n  TData = unknown,\n  TError = unknown,",
  "type SseFn = <\n  TData = unknown,\n  _TError = unknown,",
)
if (sseResultPatched === sseTypesSource || sseTypesPatched === sseResultPatched) {
  throw new Error(`SseFn patch did not apply; @hey-api/openapi-ts output may have changed (${sseTypesPath})`)
}
await Bun.write(sseTypesPath, sseTypesPatched)

await $`bun prettier --config ${path.join(dir, "../../../package.json")} --write ${generatedOutput}`
if (!verifyOnly) {
  await $`bun prettier --write src/gen`
  await $`bun prettier --write src/v2`
  await $`rm -rf dist`
  await $`bun tsc`
  await $`rm ${openapiOutput}`
}
