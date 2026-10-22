import path from "node:path"
import { mkdir } from "node:fs/promises"
const build = await Bun.build({
  entrypoints: ["src/features/sound-effects/sound-samples.ts"],
  target: "bun",
  format: "esm",
  write: false,
  plugins: [
    {
      name: "sample-paths",
      setup(builder) {
        builder.onResolve({ filter: /\.wav\?url$/ }, (args) => ({
          path: path.resolve(args.resolveDir, args.path.replace(/\?url$/, "")),
          namespace: "sample",
        }))
        builder.onLoad({ filter: /.*/, namespace: "sample" }, (args) => ({
          contents: `export default ${JSON.stringify(args.path)}`,
          loader: "js",
        }))
      },
    },
  ],
})
if (!build.success) throw new Error(JSON.stringify(build.logs))
const { rawSoundSamples: soundSamples } = await import(
  `data:text/javascript;base64,${Buffer.from(await build.outputs[0]!.text()).toString("base64")}`
)
await mkdir(".artifacts/calibration", { recursive: true })
const result: Record<string, Array<{ gain: number; lufs: number; peak: number }>> = {}
async function run(args: string[]) {
  const process = Bun.spawn(["ffmpeg", ...args], { stdout: "ignore", stderr: "pipe" })
  const log = await new Response(process.stderr).text()
  if (await process.exited) throw new Error(log)
  return log
}
for (const [name, variants] of Object.entries(soundSamples) as Array<
  [string, Array<Array<{ url: string; volume: number; delay: number }>>]
>) {
  result[name] = []
  for (const [index, sequence] of variants.entries()) {
    const output = `.artifacts/calibration/${name}-${index}.wav`
    const filters =
      sequence
        .map((sample, i) => `[${i}:a]volume=${sample.volume},adelay=${Math.round(sample.delay * 1000)}:all=1[a${i}]`)
        .join(";") + `;${sequence.map((_, i) => `[a${i}]`).join("")}amix=inputs=${sequence.length}:normalize=0[out]`
    await run([
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      ...sequence.flatMap((sample) => ["-i", sample.url]),
      "-filter_complex",
      filters,
      "-map",
      "[out]",
      "-ac",
      "1",
      "-ar",
      "32000",
      output,
    ])
    const log = await run([
      "-hide_banner",
      "-nostats",
      "-stream_loop",
      "-1",
      "-i",
      output,
      "-t",
      "8",
      "-af",
      "loudnorm=I=-20.5:TP=-1.5:LRA=7:print_format=json",
      "-f",
      "null",
      "-",
    ])
    const stats = JSON.parse(log.match(/\{[^{}]+\}/)![0])
    const gain = Math.min(-20.5 - Number(stats.input_i), -1.5 - Number(stats.input_tp))
    result[name].push({
      gain: Number((10 ** (gain / 20)).toFixed(5)),
      lufs: Number((Number(stats.input_i) + gain).toFixed(2)),
      peak: Number((Number(stats.input_tp) + gain).toFixed(2)),
    })
  }
}
await Bun.write("src/assets/sounds/levels.json", JSON.stringify(result, null, 2) + "\n")
console.log(JSON.stringify(result))
