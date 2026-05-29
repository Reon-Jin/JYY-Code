import type { Adapter, AdapterConfig, SendResult } from "./schema"
import { spawn } from "node:child_process"

function powershell(script: string, timeoutMs = 15000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, "utf-16le").toString("base64")
    const child = spawn(
      "powershell",
      ["-STA", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { timeout: timeoutMs, windowsHide: true },
    )
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()))
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()))
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(stderr || stdout || `PowerShell exited with code ${code}`))
    })
    child.on("error", reject)
  })
}

async function sendViaQQ(input: { to: string; body: string; filePath?: string }): Promise<SendResult> {
  const escapedBody = input.body
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "`n")
    .replace(/\r/g, "")
  const escapedFile = input.filePath?.replace(/\\/g, "\\\\").replace(/"/g, '\\"') || ""
  const escapedTo = input.to.replace(/\\/g, "\\\\").replace(/"/g, '\\"')

  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class W32QQ {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
}
'@

# Find QQ process
$qq = Get-Process -Name "QQ" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $qq) {
    Write-Output "ERROR:QQ is not running. Please start QQ and log in first."
    exit 1
}

# Activate QQ main window
[W32QQ]::ShowWindow($qq.MainWindowHandle, 9)
Start-Sleep -Milliseconds 100
for ($i = 0; $i -lt 20; $i++) {
    if ([W32QQ]::SetForegroundWindow($qq.MainWindowHandle)) { break }
    Start-Sleep -Milliseconds 250
}
Start-Sleep -Milliseconds 300

# QQ NT is Electron-based, SendKeys doesn't reach the renderer.
# Use mouse click on the search box instead.
$rect = New-Object W32QQ+RECT
[W32QQ]::GetWindowRect($qq.MainWindowHandle, [ref]$rect)
# Search box is at top-left area of QQ window
$sx = $rect.Left + 120
$sy = $rect.Top + 65
[W32QQ]::SetCursorPos($sx, $sy)
Start-Sleep -Milliseconds 100
[W32QQ]::mouse_event(0x0002, 0, 0, 0, 0)
Start-Sleep -Milliseconds 50
[W32QQ]::mouse_event(0x0004, 0, 0, 0, 0)
Start-Sleep -Milliseconds 400

# Paste contact name
[System.Windows.Forms.Clipboard]::SetText("${escapedTo}")
[System.Windows.Forms.SendKeys]::SendWait("^v")
Start-Sleep -Milliseconds 600
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
Start-Sleep -Milliseconds 500

${input.filePath ? `
# Send file
[System.Windows.Forms.SendKeys]::SendWait("^%o")
Start-Sleep -Milliseconds 600
[System.Windows.Forms.Clipboard]::SetText("${escapedFile}")
[System.Windows.Forms.SendKeys]::SendWait("^v")
Start-Sleep -Milliseconds 500
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
Start-Sleep -Milliseconds 600
` : ""}

# Paste and send message
[System.Windows.Forms.Clipboard]::SetText("${escapedBody}")
[System.Windows.Forms.SendKeys]::SendWait("^v")
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
Start-Sleep -Milliseconds 200

Write-Output "OK:Message sent to ${escapedTo} via QQ"
`

  try {
    const result = await powershell(script)
    if (result.stdout.includes("ERROR:")) {
      const msg = result.stdout.split("ERROR:")[1]?.trim() || "Unknown error"
      return { success: false, channel: "qq", message: msg }
    }
    return { success: true, channel: "qq", message: `Message sent to ${input.to} via QQ` }
  } catch (error: any) {
    return {
      success: false,
      channel: "qq",
      message: `QQ automation failed: ${error.message}. Make sure QQ is running and logged in.`,
    }
  }
}

export const QQAdapter: Adapter = {
  channel: "qq" as const,

  async send(_config: AdapterConfig, input: { to: string; body: string; subject?: string }): Promise<SendResult> {
    return sendViaQQ(input)
  },

  async sendFile(
    _config: AdapterConfig,
    input: { to: string; filePath: string; body?: string },
  ): Promise<SendResult> {
    const msg = input.body || `[File] ${input.filePath.split(/[/\\]/).pop()}`
    return sendViaQQ({ to: input.to, body: msg, filePath: input.filePath })
  },
}
