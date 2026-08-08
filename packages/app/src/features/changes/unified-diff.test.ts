import { describe, expect, it } from "vitest"
import { firstChangedLine, oldContentFromUnifiedDiff, parseUnifiedDiff } from "./unified-diff"

describe("parseUnifiedDiff", () => {
  it("models context, additions, deletions, and multiple hunks with line numbers", () => {
    const result = parseUnifiedDiff(`diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
 context one
-old value
+new value
 context two
@@ -10 +10,2 @@
-removed
+added
+second
`)

    expect(result.hunks).toHaveLength(2)
    expect(result.hunks[0]?.lines).toEqual([
      { kind: "context", oldNumber: 1, newNumber: 1, content: "context one" },
      { kind: "delete", oldNumber: 2, content: "old value" },
      { kind: "add", newNumber: 2, content: "new value" },
      { kind: "context", oldNumber: 3, newNumber: 3, content: "context two" },
    ])
    expect(result.hunks[1]?.lines).toEqual([
      { kind: "delete", oldNumber: 10, content: "removed" },
      { kind: "add", newNumber: 10, content: "added" },
      { kind: "add", newNumber: 11, content: "second" },
    ])
    expect(firstChangedLine(result)).toBe(2)
  })

  it("handles added, deleted, renamed, binary, and missing patches", () => {
    expect(parseUnifiedDiff("@@ -0,0 +1,2 @@\n+one\n+two\n").hunks[0]?.lines).toEqual([
      { kind: "add", newNumber: 1, content: "one" },
      { kind: "add", newNumber: 2, content: "two" },
    ])
    expect(parseUnifiedDiff("@@ -1,2 +0,0 @@\n-one\n-two\n").hunks[0]?.lines).toEqual([
      { kind: "delete", oldNumber: 1, content: "one" },
      { kind: "delete", oldNumber: 2, content: "two" },
    ])
    expect(parseUnifiedDiff("similarity index 100%\nrename from old.ts\nrename to new.ts\n").hunks).toEqual([])
    expect(parseUnifiedDiff("Binary files a/image.png and b/image.png differ\n").hunks).toEqual([])
    expect(parseUnifiedDiff(undefined).hunks).toEqual([])
    expect(oldContentFromUnifiedDiff("@@ -1,2 +0,0 @@\n-one\n-two\n")).toBe("one\ntwo")
    expect(firstChangedLine(parseUnifiedDiff("context only\n"))).toBeUndefined()
  })
})
