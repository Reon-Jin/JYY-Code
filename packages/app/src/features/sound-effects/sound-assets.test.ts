import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { expect, it } from "vitest"

it("ships small, nonempty PCM recordings rather than silent or header-only WAV files", () => {
  const directory = path.resolve(process.cwd(), "src/assets/sounds")
  const files = readdirSync(directory).filter((file) => file.endsWith(".wav"))
  expect(files).toHaveLength(14)
  let totalBytes = 0
  for (const file of files) {
    const bytes = readFileSync(path.join(directory, file))
    totalBytes += bytes.length
    expect(bytes.toString("ascii", 0, 4), file).toBe("RIFF")
    expect(bytes.toString("ascii", 8, 12), file).toBe("WAVE")
    let offset = 12
    let audio: Buffer | undefined
    while (offset + 8 <= bytes.length) {
      const size = bytes.readUInt32LE(offset + 4)
      if (bytes.toString("ascii", offset, offset + 4) === "data") {
        audio = bytes.subarray(offset + 8, offset + 8 + size)
        break
      }
      offset += 8 + size + (size % 2)
    }
    expect(audio?.length ?? 0, file).toBeGreaterThan(1000)
    let peak = 0
    if (audio) for (let i = 0; i + 1 < audio.length; i += 2) peak = Math.max(peak, Math.abs(audio.readInt16LE(i)))
    expect(peak, file).toBeGreaterThan(100)
  }
  expect(totalBytes).toBeLessThan(400 * 1024)
})
