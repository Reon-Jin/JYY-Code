import { describe, expect, it } from "vitest"
import { touchRecentProject } from "./recent-projects"

describe("recent projects", () => {
  it("deduplicates Windows paths case-insensitively and caps the list", () => {
    const result = touchRecentProject(
      Array.from({ length: 12 }, (_, index) => ({ path: `C:\\work\\p${index}`, usedAt: index })),
      "c:\\WORK\\p5",
      20,
    )

    expect(result[0]).toEqual({ path: "c:\\WORK\\p5", usedAt: 20 })
    expect(result).toHaveLength(10)
    expect(result.filter((item) => item.path.toLowerCase().endsWith("p5"))).toHaveLength(1)
  })

  it("normalizes separators for comparison without changing the newest display path", () => {
    const result = touchRecentProject([{ path: "C:\\Work\\JYYCode\\", usedAt: 1 }], "c:/work/jyycode", 2)

    expect(result).toEqual([{ path: "c:/work/jyycode", usedAt: 2 }])
  })

  it("keeps POSIX paths case-sensitive and treats backslashes as filename characters", () => {
    const result = touchRecentProject(
      [
        { path: "/Users/dev/Work", usedAt: 1 },
        { path: String.raw`/Users/dev/a\b`, usedAt: 2 },
      ],
      "/Users/dev/work/",
      3,
    )

    expect(result).toEqual([
      { path: "/Users/dev/work/", usedAt: 3 },
      { path: String.raw`/Users/dev/a\b`, usedAt: 2 },
      { path: "/Users/dev/Work", usedAt: 1 },
    ])
  })
})
