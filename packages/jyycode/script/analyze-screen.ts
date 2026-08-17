// 精确还原 TUI ANSI 输出为最终屏幕帧
import { readFileSync, writeFileSync } from "node:fs"

const input = process.argv[2]
const raw = readFileSync(input, "utf8")

const COLS = 120
const ROWS = 40
const screen = Array.from({ length: ROWS }, () => Array(COLS).fill(" "))
let row = 0
let col = 0

function put(ch: string) {
  if (ch === "\n") { row++; col = 0; return }
  if (row >= 0 && row < ROWS && col >= 0 && col < COLS) screen[row][col] = ch
  col++
}

let i = 0
const s = raw
while (i < s.length) {
  const c = s[i]
  if (c === "\x1b") {
    const m = s.slice(i).match(/^\x1b\[([0-9;?]*)([A-Za-z])/)
    if (m) {
      const params = m[1]
      const cmd = m[2]
      if (cmd === "H" || cmd === "f") {
        const [r, c2] = params.split(";").map(Number)
        row = (r ?? 1) - 1
        col = (c2 ?? 1) - 1
      } else if (cmd === "A") row -= Number(params || 1)
      else if (cmd === "B") row += Number(params || 1)
      else if (cmd === "C") col += Number(params || 1)
      else if (cmd === "D") col -= Number(params || 1)
      else if (cmd === "G") col = (Number(params || 1)) - 1
      else if (cmd === "d") row = (Number(params || 1)) - 1
      else if (cmd === "J" && params !== "2") { if (row >= 0 && row < ROWS) for (let r = row; r < ROWS; r++) for (let c3 = 0; c3 < COLS; c3++) screen[r][c3] = " " }
      else if (cmd === "J" && params === "2") { for (let r = 0; r < ROWS; r++) for (let c3 = 0; c3 < COLS; c3++) screen[r][c3] = " " }
      else if (cmd === "K") { if (row >= 0 && row < ROWS) for (let c3 = col; c3 < COLS; c3++) screen[row][c3] = " " }
      i += m[0].length
      continue
    }
    const m2 = s.slice(i).match(/^\x1b\][^\x07]*\x07/)
    if (m2) { i += m2[0].length; continue }
    i++
    continue
  }
  put(c)
  i++
}

const lines = screen.map((r) => r.join("").replace(/\s+$/, ""))
const text = lines.join("\n")
writeFileSync(input + ".txt", text)
console.log(text)
