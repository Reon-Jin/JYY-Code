/** Run with Bun. Exercises the actual conversation reducer in an isolated Chromium renderer. */
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

const root = path.resolve(import.meta.dir, "../../..")
const output = await mkdtemp(path.join(os.tmpdir(), "jyycode-computer-memory-"))
const browser = process.env.JYYCODE_CHROMIUM ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const baseline = process.argv.find((arg) => arg.startsWith("--baseline="))?.slice("--baseline=".length)
const child = spawn(
  browser,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${output}/profile`,
    "--no-first-run",
    "--disable-extensions",
    "--disable-background-networking",
    "about:blank",
  ],
  { windowsHide: true, stdio: "ignore" },
)
let socket: WebSocket | undefined
let launchError: Error | undefined
child.on("error", (error) => {
  launchError = error
})
try {
  let port: string | undefined
  for (let i = 0; i < 150; i++) {
    if (launchError) throw launchError
    port = (await readFile(path.join(output, "profile/DevToolsActivePort"), "utf8").catch(() => "")).split("\n")[0]
    if (port) break
    await Bun.sleep(100)
  }
  if (!port) throw new Error("Isolated Chromium did not start; set JYYCODE_CHROMIUM to its executable")
  const tabs = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
    type: string
    webSocketDebuggerUrl: string
  }>
  socket = new WebSocket(tabs.find((tab) => tab.type === "page")!.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => {
    socket!.onopen = () => resolve()
    socket!.onerror = () => reject(new Error("CDP unavailable"))
  })
  let id = 0
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  socket.onmessage = (event) => {
    const reply = JSON.parse(String(event.data))
    const call = pending.get(reply.id)
    if (!call) return
    pending.delete(reply.id)
    if (reply.error) call.reject(new Error(JSON.stringify(reply.error)))
    else call.resolve(reply.result)
  }
  const call = (method: string, params = {}): Promise<any> =>
    new Promise((resolve, reject) => {
      const requestID = ++id
      const timeout = setTimeout(() => {
        pending.delete(requestID)
        reject(new Error(`CDP timeout: ${method}`))
      }, 30_000)
      pending.set(requestID, {
        resolve: (value) => {
          clearTimeout(timeout)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        },
      })
      socket!.send(JSON.stringify({ id: requestID, method, params }))
    })
  const evaluate = async (expression: string) => {
    const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const reports: unknown[] = []
  for (const version of [...(baseline ? [baseline] : []), "working-tree"]) {
    let source = path.join(root, "packages/app/src/features/conversation/conversation-state.ts")
    if (version !== "working-tree") {
      const git = Bun.spawn(
        ["git", "show", `${version}:packages/app/src/features/conversation/conversation-state.ts`],
        { cwd: root },
      )
      const content = await new Response(git.stdout).text()
      if ((await git.exited) !== 0) throw new Error("Unable to read baseline reducer")
      source = path.join(output, "baseline.ts")
      await writeFile(source, content)
    }
    const fixture = path.join(output, "fixture.ts")
    await writeFile(
      fixture,
      `
      import { emptyConversationSnapshot, applyConversationEvents } from ${JSON.stringify(source.replaceAll("\\", "/"))};
      let snapshot = emptyConversationSnapshot("s");
      let next = 0;
      globalThis.feed = (count) => {
        for (let j = 0; j < count; j++) {
          const i = next++;
          const info = {id:"m"+i,sessionID:"s",role:"assistant",time:{created:i,completed:i+1}};
          // JSON round-trip models distinct inline screenshots received over SSE, without shared rope backing.
          const part = JSON.parse(JSON.stringify({id:"p"+i,messageID:info.id,sessionID:"s",type:"tool",tool:"computer",callID:"c"+i,
            state:{status:"completed",input:{},title:"Computer",output:"observation",metadata:{},time:{start:i,end:i+1},
              attachments:[{type:"file",mime:"image/png",url:"data:image/png;base64,"+"x".repeat(256*1024)+i}]}}));
          snapshot = applyConversationEvents(snapshot, [
            {directory:"d",payload:{id:"e"+String(i).padStart(6,"0")+"a",type:"message.updated",properties:{sessionID:"s",info}}},
            {directory:"d",payload:{id:"e"+String(i).padStart(6,"0")+"b",type:"message.part.updated",properties:{sessionID:"s",part,time:i}}}
          ]);
        }
        const urls = snapshot.messages.flatMap(m=>m.parts).flatMap(p=>p.state?.attachments??[]).map(a=>a.url);
        return {turns:next,messages:snapshot.messages.length,screenshots:urls.length,urlBytes:urls.reduce((n,u)=>n+u.length*2,0)};
      };
    `,
    )
    const build = await Bun.build({ entrypoints: [fixture], target: "browser", format: "iife", write: false })
    if (!build.success) throw new Error(String(build.logs))
    await evaluate(await build.outputs[0]!.text())
    const samples: Array<{ turns: number; screenshots: number; urlBytes: number; heapBytes: number }> = []
    for (const count of [100, 200, 300]) {
      const sample = await evaluate(`feed(${count})`)
      await call("HeapProfiler.collectGarbage")
      samples.push({ ...sample, heapBytes: (await call("Runtime.getHeapUsage")).usedSize })
    }
    reports.push({ version, samples })
    if (version === "working-tree") {
      const last = samples.at(-1)!
      if (
        last.screenshots > 3 ||
        last.urlBytes > 16 * 1024 * 1024 ||
        last.heapBytes - samples[0]!.heapBytes > 8 * 1024 * 1024
      ) {
        throw new Error(`Screenshot memory grew beyond budget: ${JSON.stringify(samples)}`)
      }
    }
    await evaluate("globalThis.feed = undefined")
    await call("HeapProfiler.collectGarbage")
  }
  console.log(JSON.stringify({ engine: "isolated Chromium", screenshotBytes: 256 * 1024, reports }, null, 2))
  await call("Browser.close").catch(() => undefined)
} finally {
  socket?.close()
  child.kill()
  if (child.exitCode === null)
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 1000)
      child.once("exit", () => {
        clearTimeout(timeout)
        resolve()
      })
    })
  const resolved = path.resolve(output)
  if (
    resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) &&
    path.basename(resolved).startsWith("jyycode-computer-memory-")
  ) {
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined)
  }
}
