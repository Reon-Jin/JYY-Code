import { $ } from "bun"

await $`bun ./scripts/copy-icons.ts ${process.env.JYYCODE_CHANNEL ?? "dev"}`

await $`cd ../jyycode && bun script/build-node.ts`
