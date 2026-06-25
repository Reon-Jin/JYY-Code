import { useTerminalDimensions } from "@opentui/solid"
import { For, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useTheme } from "../context/theme"

type Point3 = {
  x: number
  y: number
  z: number
}

type Point2 = {
  x: number
  y: number
}

const FPS = 30
const DURATION = 3000
const TURNS = 2
const DEPTH = 1
const Y_OFFSET = -0.2
const SCALE = 1.12

const vertices: Point3[] = [
  { x: 0.3, y: 0.5, z: -0.11 },
  { x: -0.3, y: 0.5, z: -0.11 },
  { x: -0.3, y: 0.2, z: -0.11 },
  { x: -0.54, y: -0.02, z: -0.11 },
  { x: -0.43, y: -0.11, z: -0.11 },
  { x: -0.25, y: 0.13, z: -0.11 },
  { x: -0.05, y: 0.13, z: -0.11 },
  { x: -0.05, y: -0.09, z: -0.11 },
  { x: -0.11, y: -0.14, z: -0.11 },
  { x: -0.17, y: -0.09, z: -0.11 },
  { x: -0.27, y: -0.09, z: -0.11 },
  { x: -0.13, y: -0.23, z: -0.11 },
  { x: -0.06, y: -0.23, z: -0.11 },
  { x: 0.08, y: -0.09, z: -0.11 },
  { x: 0.08, y: 0.13, z: -0.11 },
  { x: 0.22, y: 0.13, z: -0.11 },
  { x: 0.4, y: -0.09, z: -0.11 },
  { x: 0.52, y: 0.02, z: -0.11 },
  { x: 0.3, y: 0.2, z: -0.11 },
  { x: -0.05, y: 0.39, z: -0.11 },
  { x: -0.2, y: 0.39, z: -0.11 },
  { x: -0.2, y: 0.24, z: -0.11 },
  { x: -0.05, y: 0.24, z: -0.11 },
  { x: 0.22, y: 0.39, z: -0.11 },
  { x: 0.075, y: 0.39, z: -0.11 },
  { x: 0.075, y: 0.24, z: -0.11 },
  { x: 0.22, y: 0.24, z: -0.11 },
  { x: 0.3, y: 0.5, z: 0.11 },
  { x: -0.3, y: 0.5, z: 0.11 },
  { x: -0.3, y: 0.2, z: 0.11 },
  { x: -0.54, y: -0.02, z: 0.11 },
  { x: -0.43, y: -0.11, z: 0.11 },
  { x: -0.25, y: 0.13, z: 0.11 },
  { x: -0.05, y: 0.13, z: 0.11 },
  { x: -0.05, y: -0.09, z: 0.11 },
  { x: -0.11, y: -0.14, z: 0.11 },
  { x: -0.17, y: -0.09, z: 0.11 },
  { x: -0.27, y: -0.09, z: 0.11 },
  { x: -0.13, y: -0.23, z: 0.11 },
  { x: -0.06, y: -0.23, z: 0.11 },
  { x: 0.08, y: -0.09, z: 0.11 },
  { x: 0.08, y: 0.13, z: 0.11 },
  { x: 0.22, y: 0.13, z: 0.11 },
  { x: 0.4, y: -0.09, z: 0.11 },
  { x: 0.52, y: 0.02, z: 0.11 },
  { x: 0.3, y: 0.2, z: 0.11 },
  { x: -0.05, y: 0.39, z: 0.11 },
  { x: -0.2, y: 0.39, z: 0.11 },
  { x: -0.2, y: 0.24, z: 0.11 },
  { x: -0.05, y: 0.24, z: 0.11 },
  { x: 0.22, y: 0.39, z: 0.11 },
  { x: 0.075, y: 0.39, z: 0.11 },
  { x: 0.075, y: 0.24, z: 0.11 },
  { x: 0.22, y: 0.24, z: 0.11 },
]

const faces = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
  [19, 20, 21, 22],
  [23, 24, 25, 26],
  [27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45],
  [46, 47, 48, 49],
  [50, 51, 52, 53],
  [0, 1, 28, 27],
  [1, 2, 29, 28],
  [2, 3, 30, 29],
  [3, 4, 31, 30],
  [4, 5, 32, 31],
  [5, 6, 33, 32],
  [6, 7, 34, 33],
  [7, 8, 35, 34],
  [8, 9, 36, 35],
  [9, 10, 37, 36],
  [10, 11, 38, 37],
  [11, 12, 39, 38],
  [12, 13, 40, 39],
  [13, 14, 41, 40],
  [14, 15, 42, 41],
  [15, 16, 43, 42],
  [16, 17, 44, 43],
  [17, 18, 45, 44],
  [18, 0, 27, 45],
  [19, 20, 47, 46],
  [20, 21, 48, 47],
  [21, 22, 49, 48],
  [22, 19, 46, 49],
  [23, 24, 51, 50],
  [24, 25, 52, 51],
  [25, 26, 53, 52],
  [26, 23, 50, 53],
]

function rotateXZ(point: Point3, angle: number): Point3 {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return {
    x: point.x * c - point.z * s,
    y: point.y,
    z: point.x * s + point.z * c,
  }
}

function project(point: Point3): Point2 {
  const z = point.z + DEPTH
  return {
    x: point.x / z,
    y: point.y / z + Y_OFFSET,
  }
}

function plot(grid: string[][], x: number, y: number, char: string) {
  if (!grid[y]) return
  if (x < 0 || x >= grid[y].length) return
  grid[y][x] = char
}

function drawLine(grid: string[][], from: Point2, to: Point2) {
  let x0 = Math.round(from.x)
  let y0 = Math.round(from.y)
  const x1 = Math.round(to.x)
  const y1 = Math.round(to.y)
  const dx = Math.abs(x1 - x0)
  const sx = x0 < x1 ? 1 : -1
  const dy = -Math.abs(y1 - y0)
  const sy = y0 < y1 ? 1 : -1
  let error = dx + dy

  while (true) {
    plot(grid, x0, y0, x0 === x1 || y0 === y1 ? "#" : "*")
    if (x0 === x1 && y0 === y1) break
    const next = 2 * error
    if (next >= dy) {
      error += dy
      x0 += sx
    }
    if (next <= dx) {
      error += dx
      y0 += sy
    }
  }
}

function renderFrame(width: number, height: number, angle: number) {
  const columns = Math.max(8, Math.min(72, width - 4))
  const rows = Math.max(6, Math.min(28, height - 6))
  const grid = Array.from({ length: rows }, () => Array.from({ length: columns }, () => " "))
  const scale = Math.min(columns / 2.9, rows / 1.55) * SCALE
  const projected = vertices.map((point) => {
    const p = project(rotateXZ(point, angle))
    return {
      x: columns / 2 + p.x * scale * 1.55,
      y: rows / 2 - p.y * scale,
    }
  })

  for (const face of faces) {
    for (let i = 0; i < face.length; i++) {
      drawLine(grid, projected[face[i]], projected[face[(i + 1) % face.length]])
    }
  }

  return grid.map((row) => row.join(""))
}

export function StartupIntro(props: { onComplete: () => void }) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const [progress, setProgress] = createSignal(0)
  let timer: ReturnType<typeof setInterval> | undefined
  let started = 0

  onMount(() => {
    started = performance.now()
    timer = setInterval(() => {
      const next = Math.min(1, (performance.now() - started) / DURATION)
      setProgress(next)
      if (next < 1) return
      if (timer) clearInterval(timer)
      timer = undefined
      props.onComplete()
    }, 1000 / FPS)
    const handle = timer as { unref?: () => void }
    handle.unref?.()
  })

  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  const lines = createMemo(() => {
    const angle = progress() * Math.PI * 2 * TURNS
    return renderFrame(dimensions().width, dimensions().height, angle)
  })

  return (
    <box flexGrow={1} minHeight={0} justifyContent="center" alignItems="center">
      <box flexDirection="column" alignItems="center">
        <For each={lines()}>
          {(line) => (
            <text fg={theme.success} wrapMode="none">
              {line}
            </text>
          )}
        </For>
      </box>
    </box>
  )
}
