import { ChildProcess, spawn } from 'child_process'

import * as http from 'http'
import * as path from 'path'
import { findFreePort } from './findPort'

export type SidecarStatus = 'stopped' | 'starting' | 'running' | 'error'

export class SidecarManager {
  private process: ChildProcess | null = null
  private port: number = 0
  private status: SidecarStatus = 'stopped'
  private workspaceDir: string = ''

  async start(workspaceDir: string): Promise<{ port: number; baseUrl: string }> {
    if (this.status === 'running') {
      return { port: this.port, baseUrl: `http://127.0.0.1:${this.port}` }
    }

    this.workspaceDir = workspaceDir
    this.status = 'starting'
    this.port = await findFreePort()

    return new Promise(async (resolve, reject) => {
      // Determine monorepo root (packages/app/electron/../../ → monorepo root)
      const monorepoRoot = path.resolve(__dirname, '..', '..', '..', '..')

      this.process = spawn('bun', [
        'packages/jyycode/src/index.ts',
        'serve',
        '--port', String(this.port),
      ], {
        cwd: monorepoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
        env: { ...process.env, JYYCODE_HOME: workspaceDir },
      })

      this.process.stdout?.on('data', (data: Buffer) => {
        console.log(`[sidecar] ${data.toString().trim()}`)
      })

      this.process.stderr?.on('data', (data: Buffer) => {
        console.error(`[sidecar:err] ${data.toString().trim()}`)
      })

      this.process.on('error', (err) => {
        console.error('[sidecar] Process error:', err)
        this.status = 'error'
        reject(err)
      })

      this.process.on('exit', (code) => {
        console.log(`[sidecar] Process exited with code ${code}`)
        this.status = 'stopped'
        this.process = null
      })

      // Wait for health check
      this.waitForReady()
        .then(() => {
          this.status = 'running'
          resolve({ port: this.port, baseUrl: `http://127.0.0.1:${this.port}` })
        })
        .catch(reject)
    })
  }

  private async waitForReady(timeoutMs = 30000): Promise<void> {
    const startTime = Date.now()
    while (Date.now() - startTime < timeoutMs) {
      try {
        await this.healthCheck()
        return
      } catch {
        await new Promise(r => setTimeout(r, 500))
      }
    }
    throw new Error('Sidecar health check timed out after 30s')
  }

  private healthCheck(): Promise<void> {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: '127.0.0.1',
        port: this.port,
        path: '/global/health',
        method: 'GET',
        timeout: 3000,
      }
      const req = http.request(options, (res) => {
        // Any response (including non-200) means the server is accepting connections
        res.resume() // consume response data to free up memory
        resolve()
      })
      req.on('error', (err: NodeJS.ErrnoException) => {
        // ECONNRESET means the server accepted the connection but then reset —
        // this is still a sign the server is up and listening on the port
        if (err.code === 'ECONNRESET') {
          resolve()
        } else {
          reject(err)
        }
      })
      req.on('timeout', () => {
        req.destroy()
        reject(new Error('Health check request timed out'))
      })
      req.end()
    })
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill('SIGTERM')
      // Give it 5 seconds to gracefully shut down
      await new Promise(r => setTimeout(r, 5000))
      if (this.process && !this.process.killed) {
        this.process.kill('SIGKILL')
      }
      this.process = null
    }
    this.status = 'stopped'
    this.port = 0
  }

  getStatus(): SidecarStatus {
    return this.status
  }
}
